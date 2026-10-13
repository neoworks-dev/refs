// Every database query the web app makes. Route load functions and form actions call these and
// never talk to SurrealDB directly.
import type { Crawl, ElementKind, Rect, Screen, Site, UiElement, Viewport } from '../types.ts';
import { VIEWPORTS } from '../types.ts';
import { db } from './db.ts';
import {
	elementConditions,
	rows as queryRows,
	sourceCrawls,
	type NormalisedUrl
} from './library.ts';
import { RecordId } from './surreal.ts';

/** Runs a query with a single statement on the app's connection and returns its rows as plain JSON. */
async function rows<Row>(sql: string, variables: Record<string, unknown> = {}): Promise<Row[]> {
	return queryRows<Row>(await db(), sql, variables);
}

const ACTIVE_STATUSES = ['queued', 'running'];
const DEFAULT_MAX_SCREENS = 30;
// Same link depth the crawler CLI uses when it creates crawls itself.
const DEFAULT_MAX_DEPTH = 3;

// ---------------------------------------------------------------------------------------------
// Adding sites and queueing crawls
// ---------------------------------------------------------------------------------------------

export interface AddSiteInput {
	url: NormalisedUrl;
	viewports: Viewport[];
	maxScreens: number;
}

/** Creates the site if its host is new, then queues one crawl per requested viewport. */
export async function addSite(input: AddSiteInput): Promise<{ slug: string }> {
	const [existing] = await rows<Site>('SELECT * FROM site WHERE host = $host LIMIT 1', {
		host: input.url.host
	});

	let slug = existing?.slug;
	if (!existing) {
		slug = input.url.slug;
		await rows('CREATE $record CONTENT { name: $name, slug: $slug, url: $url, host: $host }', {
			record: new RecordId('site', slug),
			name: input.url.host,
			slug,
			url: input.url.url,
			host: input.url.host
		});
	}

	const siteSlug = slug as string;
	await queueCrawls(siteSlug, input.viewports, input.maxScreens);
	return { slug: siteSlug };
}

/**
 * Queues one crawl per viewport. A viewport that already has a queued or running crawl is
 * skipped so that double submits do not crawl the same site twice in parallel.
 */
async function queueCrawls(slug: string, viewports: Viewport[], maxScreens: number): Promise<void> {
	const site = new RecordId('site', slug);
	const active = await rows<{ viewport: Viewport }>(
		'SELECT viewport FROM crawl WHERE site = $site AND status IN $active',
		{ site, active: ACTIVE_STATUSES }
	);
	const busy = new Set(active.map((crawl) => crawl.viewport));

	for (const viewport of viewports) {
		if (busy.has(viewport)) continue;
		await rows(
			`CREATE crawl CONTENT {
				site: $site, viewport: $viewport, status: 'queued',
				max_screens: $maxScreens, max_depth: $maxDepth
			}`,
			{ site, viewport, maxScreens, maxDepth: DEFAULT_MAX_DEPTH }
		);
	}
}

/** Queues new crawls for both viewports, reusing the page budget of the previous crawl. */
export async function recrawl(slug: string): Promise<void> {
	const previous = await rows<{ max_screens: number }>(
		'SELECT max_screens FROM crawl WHERE site = $site ORDER BY created_at DESC LIMIT 1',
		{ site: new RecordId('site', slug) }
	);
	await queueCrawls(slug, VIEWPORTS, previous[0]?.max_screens ?? DEFAULT_MAX_SCREENS);
}

/** Marks every queued or running crawl of the site as cancelled; the worker stops on its own. */
export async function cancelCrawls(slug: string): Promise<void> {
	await rows(
		`UPDATE crawl SET status = 'cancelled', finished_at = time::now()
		 WHERE site = $site AND status IN $active`,
		{ site: new RecordId('site', slug), active: ACTIVE_STATUSES }
	);
}

// ---------------------------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------------------------

export interface CoverThumb {
	id: string;
	thumb: string;
	width: number;
	height: number;
}

export interface SiteListItem extends Site {
	covers: Partial<Record<Viewport, CoverThumb>>;
	/** Set while a crawl of this site is queued or running. */
	activeStatus?: 'queued' | 'running';
}

/** All sites, newest first, optionally filtered by a case-insensitive name/host/description match. */
export async function listSites(search = ''): Promise<SiteListItem[]> {
	const needle = search.trim().toLowerCase();
	const sites = await rows<Site>(
		`SELECT * FROM site
		 WHERE $needle = ''
			OR string::lowercase(name) CONTAINS $needle
			OR string::lowercase(host) CONTAINS $needle
			OR string::lowercase(description ?? '') CONTAINS $needle
		 ORDER BY created_at DESC`,
		{ needle }
	);
	if (sites.length === 0) return [];

	// `plain()` flattened the cover links to bare ids, so rebuild the record ids to look them up.
	const coverIds = sites.flatMap((site) =>
		[site.cover.desktop, site.cover.mobile]
			.filter((id): id is string => id !== undefined)
			.map((id) => new RecordId('screen', id))
	);
	// A site whose start page failed has no cover although other pages were captured, so those
	// viewports fall back to the first screen captured for them.
	const missingCovers = sites.flatMap((site) =>
		VIEWPORTS.filter((viewport) => site.cover[viewport] === undefined).map((viewport) => ({
			site,
			viewport
		}))
	);
	const [thumbs, activeCrawls, fallbackThumbs] = await Promise.all([
		coverIds.length === 0
			? Promise.resolve([] as CoverThumb[])
			: rows<CoverThumb>(
					'SELECT id, width, height, media.thumb AS thumb FROM screen WHERE id IN $ids',
					{ ids: coverIds }
				),
		rows<{ site: string; status: 'queued' | 'running' }>(
			'SELECT site, status FROM crawl WHERE status IN $active',
			{ active: ACTIVE_STATUSES }
		),
		Promise.all(
			missingCovers.map(async ({ site, viewport }) => {
				const [first] = await rows<CoverThumb>(
					`SELECT id, width, height, media.thumb AS thumb FROM screen
					 WHERE site = $site AND viewport = $viewport ORDER BY captured_at LIMIT 1`,
					{ site: new RecordId('site', site.id), viewport }
				);
				return { siteId: site.id, viewport, thumb: first as CoverThumb | undefined };
			})
		)
	]);

	const thumbById = new Map(thumbs.map((thumb) => [thumb.id, thumb]));
	// `running` wins over `queued` when a site has one crawl in each state.
	const statusBySite = new Map<string, 'queued' | 'running'>();
	for (const crawl of activeCrawls) {
		if (statusBySite.get(crawl.site) !== 'running') statusBySite.set(crawl.site, crawl.status);
	}

	return sites.map((site) => {
		const covers: SiteListItem['covers'] = {};
		for (const viewport of VIEWPORTS) {
			const id = site.cover[viewport];
			const fallback = fallbackThumbs.find(
				(candidate) => candidate.siteId === site.id && candidate.viewport === viewport
			)?.thumb;
			const thumb = (id === undefined ? undefined : thumbById.get(id)) ?? fallback;
			if (thumb) covers[viewport] = thumb;
		}
		return { ...site, covers, activeStatus: statusBySite.get(site.id) };
	});
}

// ---------------------------------------------------------------------------------------------
// Search palette
// ---------------------------------------------------------------------------------------------

export interface SiteHit {
	id: string;
	slug: string;
	name: string;
	host: string;
	icon?: string;
	description?: string;
}

export interface ScreenHit {
	id: string;
	/** Site slug; site record ids are their slugs. */
	site: string;
	siteName: string;
	viewport: Viewport;
	path: string;
	title: string;
	thumb: string;
	width: number;
	height: number;
}

export interface ElementHit {
	id: string;
	site: string;
	siteName: string;
	screen: string;
	viewport: Viewport;
	kind: ElementKind;
	name: string;
	media: string;
	rect: Rect;
}

export interface SearchResults {
	sites: SiteHit[];
	screens: ScreenHit[];
	elements: ElementHit[];
}

const SEARCH_LIMITS = { sites: 5, screens: 8, elements: 8 };

/**
 * Everything the search palette shows for one query: sites by name, host and description,
 * screens by title and path, and elements by name or kind. Case-insensitive substring match.
 */
export async function searchAll(search: string): Promise<SearchResults> {
	const needle = search.trim().toLowerCase();
	if (needle === '') return { sites: [], screens: [], elements: [] };

	const [sites, screens, elements] = await Promise.all([
		rows<SiteHit>(
			`SELECT id, slug, name, host, icon, description FROM site
			 WHERE string::lowercase(name) CONTAINS $needle
				OR string::lowercase(host) CONTAINS $needle
				OR string::lowercase(description ?? '') CONTAINS $needle
			 ORDER BY name LIMIT $limit`,
			{ needle, limit: SEARCH_LIMITS.sites }
		),
		// Pages sort before states ('page' < 'state') so the plain page wins over its variants.
		rows<ScreenHit>(
			`SELECT id, site, site.name AS siteName, viewport, path, title,
				media.thumb AS thumb, width, height
			 FROM screen
			 WHERE string::lowercase(title) CONTAINS $needle
				OR string::lowercase(path) CONTAINS $needle
			 ORDER BY kind, seq LIMIT $limit`,
			{ needle, limit: SEARCH_LIMITS.screens }
		),
		rows<ElementHit>(
			`SELECT id, site, site.name AS siteName, screen, viewport, kind, name, media, rect
			 FROM element
			 WHERE string::lowercase(name) CONTAINS $needle OR kind CONTAINS $needle
			 ORDER BY name DESC LIMIT $limit`,
			{ needle, limit: SEARCH_LIMITS.elements }
		)
	]);
	return { sites, screens, elements };
}

// ---------------------------------------------------------------------------------------------
// Site detail
// ---------------------------------------------------------------------------------------------

export interface SiteOverview {
	site: Site;
	/** Latest crawls first. */
	crawls: Crawl[];
	/**
	 * Crawl whose screens are shown per viewport. A recrawl adds new screens next to the old
	 * ones, so the page only ever shows the newest crawl that actually captured something.
	 */
	sources: Partial<Record<Viewport, string>>;
	screenCounts: Record<Viewport, number>;
	kindCounts: Record<Viewport, Partial<Record<ElementKind, number>>>;
}

export async function getSiteOverview(slug: string): Promise<SiteOverview | undefined> {
	const [site] = await rows<Site>('SELECT * FROM site WHERE slug = $slug LIMIT 1', { slug });
	if (!site) return undefined;
	const siteRecord = new RecordId('site', site.id);

	const [crawls, screenGroups, currentCrawls] = await Promise.all([
		rows<Crawl>('SELECT * FROM crawl WHERE site = $site ORDER BY created_at DESC LIMIT 20', {
			site: siteRecord
		}),
		// Counted from the screen table rather than `crawl.screens` so it is right even while the
		// crawler's counters lag behind.
		rows<{ crawl: string; count: number }>(
			'SELECT crawl, count() AS count FROM screen WHERE site = $site GROUP BY crawl',
			{ site: siteRecord }
		),
		db().then((database) => sourceCrawls(database, site.id))
	]);

	const screensByCrawl = new Map(screenGroups.map((group) => [group.crawl, group.count]));
	const sources: SiteOverview['sources'] = {};
	const screenCounts: SiteOverview['screenCounts'] = { desktop: 0, mobile: 0 };
	for (const crawl of currentCrawls) {
		sources[crawl.viewport] = crawl.id;
		screenCounts[crawl.viewport] = screensByCrawl.get(crawl.id) ?? 0;
	}

	const kindCounts: SiteOverview['kindCounts'] = { desktop: {}, mobile: {} };
	await Promise.all(
		VIEWPORTS.map(async (viewport) => {
			const crawlId = sources[viewport];
			if (crawlId === undefined) return;
			const { conditions, variables } = elementConditions({}, [new RecordId('crawl', crawlId)]);
			const groups = await rows<{ kind: ElementKind; count: number }>(
				`SELECT kind, count() AS count FROM element WHERE ${conditions.join(' AND ')} GROUP BY kind`,
				variables
			);
			for (const group of groups) kindCounts[viewport][group.kind] = group.count;
		})
	);

	return { site, crawls, sources, screenCounts, kindCounts };
}

/** Screens of one crawl in capture order. */
export function listScreens(crawlId: string): Promise<Screen[]> {
	return rows<Screen>('SELECT * OMIT embedding FROM screen WHERE crawl = $crawl ORDER BY seq', {
		crawl: new RecordId('crawl', crawlId)
	});
}

export interface ElementListItem extends UiElement {
	/** Capture order of the owning screen, used to keep the listing in page order. */
	screen_seq: number;
	screen_path: string;
}

/** Elements of one crawl, optionally of one kind, in page order. */
export function listElements(crawlId: string, kind?: ElementKind): Promise<ElementListItem[]> {
	const { conditions, variables } = elementConditions({ kind }, [new RecordId('crawl', crawlId)]);
	return rows<ElementListItem>(
		`SELECT *, screen.seq AS screen_seq, screen.path AS screen_path OMIT embedding FROM element
		 WHERE ${conditions.join(' AND ')}
		 ORDER BY screen_seq, rect.y
		 LIMIT 400`,
		variables
	);
}

// ---------------------------------------------------------------------------------------------
// Element library
// ---------------------------------------------------------------------------------------------

export interface LibraryElement extends ElementListItem {
	site_name: string;
	site_icon?: string;
}

export interface Library {
	/** At most `limit` elements, grouped by site and in page order within each site. */
	elements: LibraryElement[];
	hasMore: boolean;
	/** Elements per kind in the viewport, across all sites; the counts behind the filter chips. */
	kindCounts: Partial<Record<ElementKind, number>>;
}

/** Elements of every site's current crawl in one viewport, optionally of one kind. */
export async function listLibrary(
	criteria: { viewport: Viewport; kind?: ElementKind },
	limit: number
): Promise<Library> {
	const crawls = (await sourceCrawls(await db()))
		.filter((crawl) => crawl.viewport === criteria.viewport)
		.map((crawl) => new RecordId('crawl', crawl.id));
	const inViewport = elementConditions({ viewport: criteria.viewport }, crawls);
	const filtered = elementConditions(criteria, crawls);

	const [elements, kindGroups] = await Promise.all([
		// One extra row tells whether there is a next page without a separate count.
		rows<LibraryElement>(
			`SELECT *, screen.seq AS screen_seq, screen.path AS screen_path,
				site.name AS site_name, site.icon AS site_icon OMIT embedding
			 FROM element WHERE ${filtered.conditions.join(' AND ')}
			 ORDER BY site, screen_seq, rect.y, id
			 LIMIT $limit`,
			{ ...filtered.variables, limit: limit + 1 }
		),
		rows<{ kind: ElementKind; count: number }>(
			`SELECT kind, count() AS count FROM element
			 WHERE ${inViewport.conditions.join(' AND ')} GROUP BY kind`,
			inViewport.variables
		)
	]);

	const kindCounts: Library['kindCounts'] = {};
	for (const group of kindGroups) kindCounts[group.kind] = group.count;
	return { elements: elements.slice(0, limit), hasMore: elements.length > limit, kindCounts };
}

// ---------------------------------------------------------------------------------------------
// Screen viewer
// ---------------------------------------------------------------------------------------------

export interface ReachedBy {
	kind: 'navigate' | 'click';
	label: string;
	fromId: string;
	fromPath: string;
	rect?: Rect;
}

export interface ScreenDetail {
	screen: Screen;
	elements: UiElement[];
	reachedBy: ReachedBy[];
	prevId?: string;
	nextId?: string;
	/** 1-based position of the screen among the screens of its crawl. */
	position: number;
	total: number;
}

export async function getScreenDetail(
	siteId: string,
	screenId: string
): Promise<ScreenDetail | undefined> {
	const screenRecord = new RecordId('screen', screenId);
	const [screen] = await rows<Screen>(
		'SELECT * OMIT embedding FROM screen WHERE id = $screen AND site = $site',
		{
			screen: screenRecord,
			site: new RecordId('site', siteId)
		}
	);
	if (!screen) return undefined;

	const [elements, incoming, siblings] = await Promise.all([
		rows<UiElement>(
			'SELECT * OMIT embedding FROM element WHERE screen = $screen ORDER BY rect.y, rect.x',
			{
				screen: screenRecord
			}
		),
		rows<{
			kind: 'navigate' | 'click';
			label: string;
			fromId: string;
			fromPath: string;
			rect?: Rect;
		}>(
			`SELECT kind, label, rect, in AS fromId, in.path AS fromPath
			 FROM action WHERE out = $screen`,
			{ screen: screenRecord }
		),
		rows<{ id: string }>('SELECT id FROM screen WHERE crawl = $crawl ORDER BY seq', {
			crawl: new RecordId('crawl', screen.crawl)
		})
	]);

	const index = siblings.findIndex((sibling) => sibling.id === screen.id);
	return {
		screen,
		elements,
		reachedBy: incoming,
		prevId: index > 0 ? siblings[index - 1].id : undefined,
		nextId: index >= 0 && index < siblings.length - 1 ? siblings[index + 1].id : undefined,
		position: index + 1,
		total: siblings.length
	};
}
