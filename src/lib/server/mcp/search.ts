// The `search` tool: finds sites, pages, screens and elements in the library by text and by where
// they were captured.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Surreal } from 'surrealdb';
import { z } from 'zod';
import { db } from '../db.ts';
import type { ElementKind } from '../../types.ts';
import {
	elementResult,
	previewBlocks,
	errorResult,
	pageResult,
	type Result,
	screenResult,
	siteResult,
	siteSlugOf,
	textResult
} from './results.ts';
import { findSite, listPages, searchElements, searchScreens, searchSites } from './queries.ts';

// `flow` is planned for a later milestone. Add it here and to the handler, nothing else changes.
const SEARCH_TYPES = ['screen', 'element', 'site', 'page'] as const;
const VIEWPORTS = ['desktop', 'mobile'] as const;
const ELEMENT_KINDS = [
	'section',
	'header',
	'footer',
	'nav',
	'button',
	'input',
	'form',
	'dialog',
	'menu',
	'table'
] as const satisfies readonly ElementKind[];
// 10 keeps a result list small enough to read and to show with its images. 30 is the most one call
// may return, since every result adds an image to the response.
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

const SEARCH_DESCRIPTION = `Search the Refs library of websites captured by a crawler. It finds sites, pages (the distinct paths of one site), screens (captured page views and UI states) and elements (crops of UI such as navigation, buttons, forms and dialogs).

Each result comes with an inline image, and the JSON text block after the images lists the results and next_cursor. Look at the inline images rather than trusting the metadata alone, because the images show what a screen or element really looks like. When you present results to the user, cite each result's refs_url, which opens it in Refs. image_url is the full-resolution image and it doesn't expire, so link to it when the user needs detail.

Matching is a case-insensitive substring match on names, titles, paths and descriptions. It is not semantic search yet, so use words that appear on the page. Good queries: "billing toggle", "pricing", "sign up", "cookie banner". Bad queries: "the page where people compare plans" (a sentence matches nothing), "UI" (too broad to be useful).

Scope a search with site and page. site is a host such as "stripe.com" (www. and full URLs also work). page is a path such as "/pricing" and needs site. It selects the screens captured on that path, including the states revealed on it. For example, { type: "element", site: "stripe.com", page: "/pricing", query: "billing toggle" } finds the billing toggle on Stripe's pricing page.

Types: "site" lists sites, or returns one site with its counts when site is given, and it works without a query. "page" lists the distinct paths of one site and needs site. "screen" finds screens, and filter selects a page_type. "element" finds elements, and filter selects a kind such as "nav" or "dialog".`;

const searchInput = {
	type: z
		.enum(SEARCH_TYPES)
		.describe('What to search for: "site", "page" (needs site), "screen" or "element"'),
	query: z
		.string()
		.optional()
		.describe(
			'Text to match. Optional when site is given; required otherwise, except for type "site"'
		),
	site: z
		.string()
		.optional()
		.describe('Host of one site, such as "stripe.com". www. and full URLs are accepted'),
	page: z
		.string()
		.optional()
		.describe(
			'Path of a page of the site, such as "/pricing". Requires site. Not for type "site" or "page"'
		),
	viewport: z
		.enum(VIEWPORTS)
		.optional()
		.describe('Only results captured at this viewport. Both viewports when omitted'),
	filter: z
		.string()
		.optional()
		.describe('For type "element", an element kind such as "nav". For type "screen", a page_type'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_LIMIT)
		.default(DEFAULT_LIMIT)
		.describe(`How many results to return, up to ${MAX_LIMIT}`),
	cursor: z
		.string()
		.optional()
		.describe('next_cursor from the previous result, to read the next page'),
	include_images: z
		.boolean()
		.default(true)
		.describe('Whether to attach an inline image to each result')
};

interface SearchInput {
	type: (typeof SEARCH_TYPES)[number];
	query?: string;
	site?: string;
	page?: string;
	viewport?: (typeof VIEWPORTS)[number];
	filter?: string;
	limit: number;
	cursor?: string;
	include_images: boolean;
}

export function registerSearchTool(server: McpServer, origin: string): void {
	server.registerTool(
		'search',
		{
			title: 'Search Refs',
			description: SEARCH_DESCRIPTION,
			inputSchema: searchInput,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
		},
		(input) => search(input, origin)
	);
}

async function search(input: SearchInput, origin: string): Promise<CallToolResult> {
	const problem = checkArguments(input);
	if (problem !== undefined) return errorResult(problem);

	let site: string | undefined;
	if (input.site !== undefined) {
		site = siteSlugOf(input.site);
		if (site === undefined) {
			return errorResult(`"${input.site}" is not a site. Pass a host such as "stripe.com".`);
		}
	}
	const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor);
	if (offset === undefined) {
		return errorResult('cursor is not valid. Pass next_cursor from a previous search result.');
	}

	const database = await db();
	if (site !== undefined && (await findSite(database, site)) === undefined) {
		return errorResult(`No site "${input.site}" is in Refs.`);
	}
	const page = await findPage(database, input, origin, site, offset);
	const previews = input.include_images
		? await previewBlocks(page.results.map((result) => result.imageKey))
		: [];
	return textResult(
		{ results: page.results.map((result) => result.json), next_cursor: page.nextCursor },
		previews
	);
}

/** One page of results for the validated input, read from the database and shaped for the response. */
async function findPage(
	database: Surreal,
	input: SearchInput,
	origin: string,
	site: string | undefined,
	offset: number
): Promise<{ results: Result[]; nextCursor: string | null }> {
	const needle = input.query?.trim().toLowerCase() ?? '';
	// One more row than the page size, so the response can say whether a next page exists.
	const paging = { limit: input.limit + 1, offset };
	const scope = { site, viewport: input.viewport, needle };
	const limit = input.limit;

	if (input.type === 'site') {
		const sites = await searchSites(database, { site, needle }, paging);
		return firstPage(sites, limit, offset, (summary) =>
			siteResult(origin, summary, summary.cover_media?.viewport)
		);
	}
	if (input.type === 'page') {
		// checkArguments already rejected a page search without a site.
		const pageSite = site ?? '';
		// Pages are grouped from every matching screen, so the grouping happens before the page cut.
		const groups = await listPages(database, scope);
		return firstPage(groups.slice(offset), limit, offset, (group) =>
			pageResult(origin, pageSite, group)
		);
	}
	if (input.type === 'screen') {
		const screens = await searchScreens(
			database,
			{ ...scope, path: input.page, pageType: input.filter },
			paging
		);
		return firstPage(screens, limit, offset, (screen) =>
			screenResult(origin, screen, screen.media.viewport)
		);
	}
	const elements = await searchElements(
		database,
		{ ...scope, path: input.page, kind: input.filter as ElementKind | undefined },
		paging
	);
	return firstPage(elements, limit, offset, (element) => elementResult(origin, element));
}

/** The first `limit` rows shaped as results, and the cursor of the next page when there are more rows. */
function firstPage<Row>(
	rows: Row[],
	limit: number,
	offset: number,
	shape: (row: Row) => Result
): { results: Result[]; nextCursor: string | null } {
	const hasMore = rows.length > limit;
	return {
		results: rows.slice(0, limit).map(shape),
		nextCursor: hasMore ? encodeCursor(offset + limit) : null
	};
}

/**
 * The first problem with the arguments, or undefined when they make a valid search. Checked before
 * anything touches the database, so a model gets the reason for a rejected call straight away.
 */
function checkArguments(input: SearchInput): string | undefined {
	if (input.page !== undefined && input.site === undefined) {
		return 'page needs site, for example { site: "stripe.com", page: "/pricing" }.';
	}
	if (input.page !== undefined && (input.type === 'site' || input.type === 'page')) {
		return `page does not apply to type "${input.type}".`;
	}
	if (input.type === 'page' && input.site === undefined) {
		return 'type "page" lists the pages of one site, so it needs site.';
	}
	// Without a site the query is what narrows the search. A site list may skip it and list everything.
	const hasQuery = (input.query?.trim() ?? '') !== '';
	if (!hasQuery && input.site === undefined && input.type !== 'site') {
		return 'query is required unless site is given.';
	}
	if (input.filter !== undefined) {
		if (input.type === 'element' && !isElementKind(input.filter)) {
			return `filter must be an element kind: ${ELEMENT_KINDS.join(', ')}.`;
		}
		if (input.type !== 'element' && input.type !== 'screen') {
			return 'filter applies to type "screen" (page_type) and "element" (kind) only.';
		}
	}
	return undefined;
}

function isElementKind(value: string): value is ElementKind {
	return (ELEMENT_KINDS as readonly string[]).includes(value);
}

// Cursors are the offset of the next page, base64url encoded so the model treats them as opaque.
function encodeCursor(offset: number): string {
	return Buffer.from(String(offset)).toString('base64url');
}

/** The offset a cursor holds, or undefined when the cursor was not produced by encodeCursor. */
function decodeCursor(cursor: string): number | undefined {
	const text = Buffer.from(cursor, 'base64url').toString();
	return /^\d+$/.test(text) ? Number(text) : undefined;
}
