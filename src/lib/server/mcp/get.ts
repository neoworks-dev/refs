// The `get` tool: fetches one screen or one site by the id a search result returned.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { db } from '../db.ts';
import {
	elementResult,
	previewBlocks,
	errorResult,
	pageResult,
	screenResult,
	siteResult,
	siteSlugOf,
	textResult
} from './results.ts';
import { findSite, getScreen, listPages, searchSites } from './queries.ts';

const GET_DESCRIPTION = `Fetch one screen or one site by the id a search result returned. Pass type "screen" or "site" to say which.

A screen returns its fields, its elements (kind, name, rect and image_url for each crop) and reached_by, which lists the clicks and navigations that led to it, each with the id of the screen it started on. It also returns one inline image: the part of the page above the fold by default, or the whole page with image "full". A full page is very tall, so the image may be scaled down.

A site returns its fields, its counts, its pages (the same shape as search with type "page") and the ids of its cover screens, which are the screens shown on its card. It also returns one inline image of the cover.

Look at the inline image rather than trusting the metadata alone. When you present the result, cite its refs_url. image_url is the full-resolution link and doesn't expire.`;

const getInput = {
	id: z
		.string()
		.min(1)
		.describe('The id from a search result. For a site, the host or the slug works too'),
	type: z.enum(['screen', 'site']).describe('What the id refers to'),
	image: z
		.enum(['viewport', 'full'])
		.default('viewport')
		.describe(
			'"viewport" for the part above the fold, "full" for the whole page (can be very tall)'
		)
};

export function registerGetTool(server: McpServer, origin: string): void {
	server.registerTool(
		'get',
		{
			title: 'Get a Refs screen or site',
			description: GET_DESCRIPTION,
			inputSchema: getInput,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
		},
		async ({ id, type, image }) => {
			const database = await db();
			if (type === 'screen') {
				const found = await getScreen(database, id);
				if (found === undefined) return errorResult(`No screen "${id}" is in Refs.`);
				const imageKey = image === 'full' ? found.screen.media.full : found.screen.media.viewport;
				const screen = screenResult(origin, found.screen, imageKey).json;
				return textResult(
					{
						...screen,
						elements: found.elements.map((element) => elementResult(origin, element).json),
						reached_by: found.reachedBy
					},
					await previewBlocks([imageKey])
				);
			}
			return getSite(origin, id, image);
		}
	);
}

async function getSite(
	origin: string,
	id: string,
	image: 'viewport' | 'full'
): Promise<CallToolResult> {
	// Ids are slugs, but a host such as "stripe.com" is accepted as well, the way search takes it.
	const slug = id.includes('.') ? siteSlugOf(id) : id;
	if (slug === undefined)
		return errorResult(`"${id}" is not a site. Pass a host such as "stripe.com".`);

	const database = await db();
	if ((await findSite(database, slug)) === undefined)
		return errorResult(`No site "${id}" is in Refs.`);

	const [summary] = await searchSites(database, { site: slug }, { limit: 1, offset: 0 });
	const pages = await listPages(database, { site: slug });
	const coverMedia = summary.cover_media;
	const imageKey =
		coverMedia === undefined ? undefined : image === 'full' ? coverMedia.full : coverMedia.viewport;
	const site = siteResult(origin, summary, imageKey).json;
	return textResult(
		{
			...site,
			covers: summary.cover,
			pages: pages.map((page) => pageResult(origin, slug, page).json)
		},
		await previewBlocks([imageKey])
	);
}
