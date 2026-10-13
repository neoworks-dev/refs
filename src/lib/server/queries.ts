// Every database query the web app makes. Route load functions and form actions call these and
// never talk to SurrealDB directly.
import type { Crawl, ElementKind, Rect, Screen, Site, UiElement, Viewport } from '../types.ts';
import { VIEWPORTS } from '../types.ts';
import { db } from './db.ts';
import { plain, RecordId } from './surreal.ts';

/** Runs a query with a single statement and returns its rows as plain JSON. */
async function rows<Row>(sql: string, variables: Record<string, unknown> = {}): Promise<Row[]> {
	const [result] = await (await db()).query(sql, variables).collect<[Row[]]>();
	return plain<Row[]>(result);
}

const ACTIVE_STATUSES = ['queued', 'running'];
const DEFAULT_MAX_SCREENS = 30;
// Same link depth the crawler CLI uses when it creates crawls itself.
const DEFAULT_MAX_DEPTH = 3;

// ---------------------------------------------------------------------------------------------
// Adding sites and queueing crawls
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
	const [thumbs, activeCrawls] = await Promise.all([
		coverIds.length === 0
			? Promise.resolve([] as CoverThumb[])
			: rows<CoverThumb>(
					'SELECT id, width, height, media.thumb AS thumb FROM screen WHERE id IN $ids',
					{ ids: coverIds }
				),
		rows<{ site: string; status: 'queued' | 'running' }>(
			'SELECT site, status FROM crawl WHERE status IN $active',
			{ active: ACTIVE_STATUSES }
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
			const thumb = id === undefined ? undefined : thumbById.get(id);
			if (thumb) covers[viewport] = thumb;
		}
		return { ...site, covers, activeStatus: statusBySite.get(site.id) };
	});
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

	const [crawls, screenGroups] = await Promise.all([
		rows<Crawl>('SELECT * FROM crawl WHERE site = $site ORDER BY created_at DESC LIMIT 20', {
			site: siteRecord
		}),
		// Counted from the screen table rather than `crawl.screens` so it is right even while the
		// crawler's counters lag behind.
		rows<{ crawl: string; count: number }>(
			'SELECT crawl, count() AS count FROM screen WHERE site = $site GROUP BY crawl',
			{ site: siteRecord }
		)
	]);

	const screensByCrawl = new Map(screenGroups.map((group) => [group.crawl, group.count]));
	const sources: SiteOverview['sources'] = {};
	const screenCounts: SiteOverview['screenCounts'] = { desktop: 0, mobile: 0 };
	for (const viewport of VIEWPORTS) {
		const candidates = crawls.filter(
			(crawl) => crawl.viewport === viewport && (screensByCrawl.get(crawl.id) ?? 0) > 0
		);
		// Prefer a crawl that finished or is in progress over a cancelled/failed partial one.
		const source =
			candidates.find((crawl) => crawl.status === 'done' || crawl.status === 'running') ??
			candidates[0];
		if (source) {
			sources[viewport] = source.id;
			screenCounts[viewport] = screensByCrawl.get(source.id) ?? 0;
		}
	}

	const kindCounts: SiteOverview['kindCounts'] = { desktop: {}, mobile: {} };
	await Promise.all(
		VIEWPORTS.map(async (viewport) => {
			const crawlId = sources[viewport];
			if (crawlId === undefined) return;
			const groups = await rows<{ kind: ElementKind; count: number }>(
				`SELECT kind, count() AS count FROM element
				 WHERE screen IN (SELECT VALUE id FROM screen WHERE crawl = $crawl)
				 GROUP BY kind`,
				{ crawl: new RecordId('crawl', crawlId) }
			);
			for (const group of groups) kindCounts[viewport][group.kind] = group.count;
		})
	);

	return { site, crawls, sources, screenCounts, kindCounts };
}

/** Screens of one crawl in capture order. */
export function listScreens(crawlId: string): Promise<Screen[]> {
	return rows<Screen>('SELECT * FROM screen WHERE crawl = $crawl ORDER BY seq', {
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
	return rows<ElementListItem>(
		`SELECT *, screen.seq AS screen_seq, screen.path AS screen_path FROM element
		 WHERE screen IN (SELECT VALUE id FROM screen WHERE crawl = $crawl)
			AND ($kind = '' OR kind = $kind)
		 ORDER BY screen_seq, rect.y
		 LIMIT 400`,
		{ crawl: new RecordId('crawl', crawlId), kind: kind ?? '' }
	);
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
	const [screen] = await rows<Screen>('SELECT * FROM screen WHERE id = $screen AND site = $site', {
		screen: screenRecord,
		site: new RecordId('site', siteId)
	});
	if (!screen) return undefined;

	const [elements, incoming, siblings] = await Promise.all([
		rows<UiElement>('SELECT * FROM element WHERE screen = $screen ORDER BY rect.y, rect.x', {
			screen: screenRecord
		}),
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
