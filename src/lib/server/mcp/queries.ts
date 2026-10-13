// Read queries behind the MCP tools. They return plain JSON like `src/lib/server/queries.ts`, and
// share with it what has to match the website (current crawls, filters) through `../library.ts`.
import type { Surreal } from 'surrealdb';
import type { ElementKind, Rect, Viewport } from '../../types.ts';
import {
	elementConditions,
	rows,
	screenConditions,
	sourceCrawls,
	type ElementCriteria,
	type ScreenCriteria
} from '../library.ts';
import { RecordId } from '../surreal.ts';

/** The record ids of the crawls whose screens the tools read. */
async function sourceCrawlIds(database: Surreal): Promise<RecordId[]> {
	return (await sourceCrawls(database)).map((crawl) => new RecordId('crawl', crawl.id));
}

export interface SiteRow {
	id: string;
	name: string;
	host: string;
	url: string;
	description?: string;
	cover: { desktop?: string; mobile?: string };
}

export interface SiteCounts {
	pages: number;
	states: number;
	elements: number;
}

export interface SiteSummary extends SiteRow {
	counts: SiteCounts;
	/** Media keys of the cover screen, desktop first. Undefined when the site has no cover yet. */
	cover_media?: { viewport: string; full: string };
}

export interface ScreenRow {
	id: string;
	site: string;
	url: string;
	path: string;
	title: string;
	viewport: Viewport;
	kind: 'page' | 'state';
	page_type?: string;
	description?: string;
	width: number;
	height: number;
	full_height: number;
	media: { viewport: string; full: string };
}

export interface ElementRow {
	id: string;
	site: string;
	screen: string;
	viewport: Viewport;
	kind: ElementKind;
	name: string;
	label?: string;
	rect: Rect;
	media: string;
}

/** One distinct path of a site in one viewport, represented by its page screen where there is one. */
export interface PageGroup {
	/** Screen id of the representative capture. */
	id: string;
	path: string;
	title: string;
	viewport: Viewport;
	page_count: number;
	state_count: number;
	/** Media key of the representative's viewport image. */
	image: string;
}

export interface ReachedBy {
	kind: 'navigate' | 'click';
	label: string;
	/** Screen id of the screen the action started on. */
	source: string;
}

/** Which page of a result list to read. The caller asks for one more row than it shows, to learn whether there is a next page. */
export interface Paging {
	limit: number;
	offset: number;
}

/** Screens in capture order per site and viewport, one page of them. */
export async function searchScreens(
	database: Surreal,
	criteria: ScreenCriteria,
	paging: Paging
): Promise<ScreenRow[]> {
	const crawls = await sourceCrawlIds(database);
	const { conditions, variables } = screenConditions(criteria, crawls);
	return rows<ScreenRow>(
		database,
		`SELECT id, site, url, path, title, viewport, kind, page_type, description,
			width, height, full_height, media
		 FROM screen WHERE ${conditions.join(' AND ')}
		 ORDER BY site, viewport, seq, id
		 LIMIT $limit START $offset`,
		{ ...variables, limit: paging.limit, offset: paging.offset }
	);
}

/**
 * Distinct paths of the matching screens, one group per path and viewport. Groups are returned in
 * capture order, so a site's pages read top to bottom as they were crawled.
 */
export async function listPages(database: Surreal, criteria: ScreenCriteria): Promise<PageGroup[]> {
	const crawls = await sourceCrawlIds(database);
	const { conditions, variables } = screenConditions(criteria, crawls);
	const screens = await rows<
		Pick<ScreenRow, 'id' | 'path' | 'title' | 'viewport' | 'kind' | 'media'> & { seq: number }
	>(
		database,
		`SELECT id, path, title, viewport, kind, media, seq FROM screen
		 WHERE ${conditions.join(' AND ')}
		 ORDER BY viewport, seq, id`,
		variables
	);

	const groups = new Map<string, PageGroup>();
	for (const screen of screens) {
		const key = `${screen.viewport} ${screen.path}`;
		const group = groups.get(key) ?? {
			id: screen.id,
			path: screen.path,
			title: screen.title,
			viewport: screen.viewport,
			page_count: 0,
			state_count: 0,
			image: screen.media.viewport
		};
		if (screen.kind === 'page') group.page_count += 1;
		else group.state_count += 1;
		// A plain page represents its path. A state is shown only when the path has no page capture.
		if (screen.kind === 'page' && group.page_count === 1) {
			group.id = screen.id;
			group.title = screen.title;
			group.image = screen.media.viewport;
		}
		groups.set(key, group);
	}
	return [...groups.values()];
}

/** Elements of matching screens, filtered by kind and name or label, in page order. */
export async function searchElements(
	database: Surreal,
	criteria: ElementCriteria,
	paging: Paging
): Promise<ElementRow[]> {
	const crawls = await sourceCrawlIds(database);
	const { conditions, variables } = elementConditions(criteria, crawls);
	return rows<ElementRow>(
		database,
		`SELECT id, site, screen, viewport, kind, name, label, rect, media FROM element
		 WHERE ${conditions.join(' AND ')}
		 ORDER BY screen, rect.y, rect.x, id
		 LIMIT $limit START $offset`,
		{ ...variables, limit: paging.limit, offset: paging.offset }
	);
}

/** One site by its slug (record id), or undefined when the library has no such site. */
export async function findSite(database: Surreal, slug: string): Promise<SiteRow | undefined> {
	const [site] = await rows<SiteRow>(
		database,
		'SELECT id, name, host, url, description, cover FROM site WHERE id = $site LIMIT 1',
		{ site: new RecordId('site', slug) }
	);
	return site;
}

/** Sites matching a lowercase substring of name, host or description, in name order. */
export async function searchSites(
	database: Surreal,
	criteria: { site?: string; needle?: string },
	paging: Paging
): Promise<SiteSummary[]> {
	const conditions: string[] = [];
	const variables: Record<string, unknown> = { limit: paging.limit, offset: paging.offset };
	if (criteria.site !== undefined) {
		conditions.push('id = $site');
		variables.site = new RecordId('site', criteria.site);
	}
	if (criteria.needle) {
		conditions.push(`(string::lowercase(name) CONTAINS $needle
			OR string::lowercase(host) CONTAINS $needle
			OR string::lowercase(description ?? '') CONTAINS $needle)`);
		variables.needle = criteria.needle;
	}
	const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
	const sites = await rows<SiteRow>(
		database,
		`SELECT id, name, host, url, description, cover FROM site ${where}
		 ORDER BY name, id LIMIT $limit START $offset`,
		variables
	);
	return summariseSites(database, sites);
}

/** Counts and cover media for sites, read from the source crawls. */
async function summariseSites(database: Surreal, sites: SiteRow[]): Promise<SiteSummary[]> {
	if (sites.length === 0) return [];
	const crawls = await sourceCrawlIds(database);
	const siteIds = sites.map((site) => new RecordId('site', site.id));
	const coverIds = sites.flatMap((site) =>
		[site.cover.desktop, site.cover.mobile]
			.filter((id): id is string => id !== undefined)
			.map((id) => new RecordId('screen', id))
	);

	const [screenGroups, elementGroups, covers] = await Promise.all([
		rows<{ site: string; kind: 'page' | 'state'; count: number }>(
			database,
			`SELECT site, kind, count() AS count FROM screen
			 WHERE crawl IN $crawls AND site IN $sites GROUP BY site, kind`,
			{ crawls, sites: siteIds }
		),
		rows<{ site: string; count: number }>(
			database,
			`SELECT site, count() AS count FROM element
			 WHERE crawl IN $crawls
				AND site IN $sites GROUP BY site`,
			{ crawls, sites: siteIds }
		),
		rows<{ id: string; media: { viewport: string; full: string } }>(
			database,
			'SELECT id, media FROM screen WHERE id IN $covers',
			{ covers: coverIds }
		)
	]);

	return sites.map((site) => {
		const screenCount = (kind: 'page' | 'state') =>
			screenGroups.find((group) => group.site === site.id && group.kind === kind)?.count ?? 0;
		const elementCount = elementGroups.find((group) => group.site === site.id)?.count ?? 0;
		const coverScreenId = site.cover.desktop ?? site.cover.mobile;
		const cover = covers.find((screen) => screen.id === coverScreenId);
		return {
			...site,
			counts: { pages: screenCount('page'), states: screenCount('state'), elements: elementCount },
			cover_media: cover?.media
		};
	});
}

/** A single screen with its elements and the actions that led to it. Undefined when not in a source crawl. */
export async function getScreen(
	database: Surreal,
	screenId: string
): Promise<{ screen: ScreenRow; elements: ElementRow[]; reachedBy: ReachedBy[] } | undefined> {
	const crawls = await sourceCrawlIds(database);
	const [screen] = await rows<ScreenRow>(
		database,
		`SELECT id, site, url, path, title, viewport, kind, page_type, description,
			width, height, full_height, media
		 FROM screen WHERE id = $screen AND crawl IN $crawls`,
		{ screen: new RecordId('screen', screenId), crawls }
	);
	if (screen === undefined) return undefined;

	const [elements, reachedBy] = await Promise.all([
		rows<ElementRow>(
			database,
			`SELECT id, site, screen, viewport, kind, name, label, rect, media FROM element
			 WHERE screen = $screen ORDER BY rect.y, rect.x, id`,
			{ screen: new RecordId('screen', screenId) }
		),
		rows<ReachedBy>(
			database,
			`SELECT kind, label, in AS source FROM action
			 WHERE out = $screen AND crawl IN $crawls`,
			{ screen: new RecordId('screen', screenId), crawls }
		)
	]);
	return { screen, elements, reachedBy };
}
