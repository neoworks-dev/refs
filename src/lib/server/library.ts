// What the web app (`queries.ts`) and the MCP server (`mcp/queries.ts`) must agree on, so that a
// tool call and the website never show different things: which crawl of a site is current, how
// screens and elements are filtered, and how a site URL becomes a slug. Everything specific to one
// side stays in that side's own queries.
import type { Surreal } from 'surrealdb';
import type { CrawlStatus, ElementKind, Viewport } from '../types.ts';
import { plain, RecordId } from './surreal.ts';

/** Runs a query with a single statement and returns its rows as plain JSON. */
export async function rows<Row>(
	database: Surreal,
	sql: string,
	variables: Record<string, unknown> = {}
): Promise<Row[]> {
	const [result] = await database.query(sql, variables).collect<[Row[]]>();
	return plain<Row[]>(result);
}

// ---------------------------------------------------------------------------------------------
// Site URLs
// ---------------------------------------------------------------------------------------------

export interface NormalisedUrl {
	url: string;
	host: string;
	slug: string;
}

/**
 * Mirrors the crawler CLI: https is the default scheme, host is lowercased, the hash and the
 * trailing slash are dropped. `host` additionally loses `www.`, and `slug` is the host with dots
 * replaced by dashes. Returns undefined when the input is not a usable http(s) URL.
 */
export function normaliseUrl(input: string): NormalisedUrl | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	// A scheme is anything like `http://`. A bare `example.com:3000` has no `//` so it gets https.
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;

	const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
	// Reject things like `https://foo`: a crawlable site needs a dotted host (or localhost).
	if (!host.includes('.') && host !== 'localhost') return undefined;

	parsed.hash = '';
	const url = parsed.href.replace(/\/$/, '');
	return { url, host, slug: host.replaceAll('.', '-') };
}

// ---------------------------------------------------------------------------------------------
// Current crawls
// ---------------------------------------------------------------------------------------------

export interface SourceCrawl {
	id: string;
	site: string;
	viewport: Viewport;
	status: CrawlStatus;
}

/** Statuses of a crawl that finished or is still adding screens, as opposed to a partial leftover. */
const CAPTURED_STATUSES: CrawlStatus[] = ['done', 'running'];

/**
 * The crawl whose screens are shown for each site and viewport. A recrawl adds new screens next to
 * the old ones, so only the newest crawl that captured something counts, preferring one that
 * finished or is running over a cancelled or failed partial one. Without this a recrawl would show
 * every page twice. Pass `site` (a slug) to look at a single site.
 */
export async function sourceCrawls(database: Surreal, site?: string): Promise<SourceCrawl[]> {
	const crawls = await rows<SourceCrawl>(
		database,
		`SELECT id, site, viewport, status FROM crawl
		 WHERE id IN (SELECT VALUE crawl FROM screen) ${site === undefined ? '' : 'AND site = $site'}
		 ORDER BY created_at DESC`,
		site === undefined ? {} : { site: new RecordId('site', site) }
	);
	const chosen = new Map<string, SourceCrawl>();
	for (const crawl of crawls) {
		const key = `${crawl.site} ${crawl.viewport}`;
		const current = chosen.get(key);
		// The list is newest first, so an earlier candidate only loses to a later captured one.
		const currentIsCaptured = current !== undefined && CAPTURED_STATUSES.includes(current.status);
		if (current === undefined || (!currentIsCaptured && CAPTURED_STATUSES.includes(crawl.status))) {
			chosen.set(key, crawl);
		}
	}
	return [...chosen.values()];
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

export interface Conditions {
	conditions: string[];
	variables: Record<string, unknown>;
}

/** Filters that select screens. Every field is optional and they combine with AND. */
export interface ScreenCriteria {
	/** Site slug, which is also the site record id. */
	site?: string;
	path?: string;
	viewport?: Viewport;
	pageType?: string;
	/** Lowercased substring, matched against title, path and description. */
	needle?: string;
}

/** WHERE conditions and variables for screens that match `criteria`, restricted to `crawls`. */
export function screenConditions(criteria: ScreenCriteria, crawls: RecordId[]): Conditions {
	const conditions = ['crawl IN $crawls'];
	const variables: Record<string, unknown> = { crawls };
	if (criteria.site !== undefined) {
		conditions.push('site = $site');
		variables.site = new RecordId('site', criteria.site);
	}
	if (criteria.path !== undefined) {
		conditions.push('path = $path');
		variables.path = criteria.path;
	}
	if (criteria.viewport !== undefined) {
		conditions.push('viewport = $viewport');
		variables.viewport = criteria.viewport;
	}
	if (criteria.pageType !== undefined) {
		conditions.push('page_type = $pageType');
		variables.pageType = criteria.pageType;
	}
	if (criteria.needle) {
		conditions.push(`(string::lowercase(title) CONTAINS $needle
			OR string::lowercase(path) CONTAINS $needle
			OR string::lowercase(description ?? '') CONTAINS $needle)`);
		variables.needle = criteria.needle;
	}
	return { conditions, variables };
}

/** Filters that select elements. Every field is optional and they combine with AND. */
export interface ElementCriteria {
	site?: string;
	/** Path of the screen the element was cropped from. */
	path?: string;
	viewport?: Viewport;
	kind?: ElementKind;
	/** Lowercased substring, matched against name and label. */
	needle?: string;
}

/**
 * WHERE conditions and variables for elements that match `criteria`, restricted to elements of
 * screens in `crawls`. Elements carry their site and viewport themselves, so those two are
 * filtered directly; the page path has to go through the screen.
 */
export function elementConditions(criteria: ElementCriteria, crawls: RecordId[]): Conditions {
	const screens = screenConditions({ site: criteria.site, path: criteria.path }, crawls);
	const conditions = [
		`screen IN (SELECT VALUE id FROM screen WHERE ${screens.conditions.join(' AND ')})`
	];
	const variables: Record<string, unknown> = { ...screens.variables };
	if (criteria.site !== undefined) conditions.push('site = $site');
	if (criteria.viewport !== undefined) {
		conditions.push('viewport = $viewport');
		variables.viewport = criteria.viewport;
	}
	if (criteria.kind !== undefined) {
		conditions.push('kind = $kind');
		variables.kind = criteria.kind;
	}
	if (criteria.needle) {
		conditions.push(`(string::lowercase(name) CONTAINS $needle
			OR string::lowercase(label ?? '') CONTAINS $needle)`);
		variables.needle = criteria.needle;
	}
	return { conditions, variables };
}
