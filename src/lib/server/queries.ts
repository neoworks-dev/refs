// Every database query the web app makes. Route load functions and form actions call these and
// never talk to SurrealDB directly.
import * as env from '$app/env/private';
import type {
	Crawl,
	ElementKind,
	Flow,
	LiveGoal,
	Rect,
	Screen,
	SectionLabel,
	Site,
	UiElement,
	Viewport
} from '../types.ts';
import { FLOW_CATEGORIES, VIEWPORTS } from '../types.ts';
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

/** A screen whose picture the query matches by meaning. */
export interface SemanticScreenHit extends ScreenHit {
	pageType?: string;
	description?: string;
}

/** A section crop that the query matches by meaning. */
export interface SemanticSectionHit {
	id: string;
	site: string;
	siteName: string;
	screen: string;
	screenPath: string;
	viewport: Viewport;
	label?: SectionLabel;
	name: string;
	media: string;
	rect: Rect;
}

export interface SemanticResults {
	screens: SemanticScreenHit[];
	sections: SemanticSectionHit[];
}

const MODEL_SERVICE_URL = env.REFS_ML_URL ?? 'http://127.0.0.1:8022';
// Must match the dimension of the HNSW indexes in db/schema.surql.
const EMBEDDING_DIMENSIONS = 1024;
const SEMANTIC_LIMIT = 8;
// How many neighbours the index returns before the current-crawl filter runs. The index also
// holds superseded crawls, so asking for only SEMANTIC_LIMIT could leave fewer after filtering.
const NEIGHBOURS = 50;
// The HNSW search effort (`ef`): the number of candidates it explores. Higher is more exact
// and slower; twice the neighbour count is plenty for a library this size.
const SEARCH_EFFORT = 100;

/**
 * Turns the query into a vector with the model service. Returns undefined when the service is
 * not running, so the palette can carry on with the name matches alone.
 */
async function embedQuery(text: string): Promise<number[] | undefined> {
	const form = new FormData();
	form.set('text', text);
	form.set('dimensions', String(EMBEDDING_DIMENSIONS));
	let response: Response;
	try {
		response = await fetch(`${MODEL_SERVICE_URL}/embed`, { method: 'POST', body: form });
	} catch (error) {
		// fetch rejects with a bare TypeError; a refused connection (nothing listening on the port)
		// is the one failure that means "the service is not running" and is expected.
		const cause =
			error instanceof TypeError ? (error.cause as { code?: string } | undefined) : undefined;
		if (cause?.code === 'ECONNREFUSED') return undefined;
		throw error;
	}
	if (!response.ok) throw new Error(`embedding failed with ${response.status}`);
	const { vector } = (await response.json()) as { vector: number[] };
	return vector;
}

/**
 * Screens and sections whose picture is closest to the meaning of the query. Empty when the
 * model service is down.
 */
export async function searchByMeaning(search: string): Promise<SemanticResults> {
	const text = search.trim();
	const vector = text === '' ? undefined : await embedQuery(text);
	if (vector === undefined) return { screens: [], sections: [] };
	const crawls = (await sourceCrawls(await db())).map((crawl) => new RecordId('crawl', crawl.id));

	// The WHERE next to the KNN operator would apply after the top k, so the subquery oversamples
	// and the filter on current crawls runs outside it.
	const [screenMatches, sectionMatches] = await Promise.all([
		rows<{ id: string }>(
			`SELECT id, site, path, page_type, viewport, distance FROM (
				SELECT id, site, path, page_type, viewport, crawl, vector::distance::knn() AS distance
				FROM screen WHERE embedding <|${NEIGHBOURS},${SEARCH_EFFORT}|> $vector
			) WHERE crawl IN $crawls ORDER BY distance LIMIT $limit`,
			{ vector, crawls, limit: SEMANTIC_LIMIT }
		),
		rows<{ id: string }>(
			`SELECT id, site, screen, viewport, label, distance FROM (
				SELECT id, site, screen, viewport, label, kind, screen.crawl AS crawl,
					vector::distance::knn() AS distance
				FROM element WHERE embedding <|${NEIGHBOURS},${SEARCH_EFFORT}|> $vector
			) WHERE kind = 'section' AND crawl IN $crawls ORDER BY distance LIMIT $limit`,
			{ vector, crawls, limit: SEMANTIC_LIMIT }
		)
	]);

	// The KNN rows carry no display fields; look them up and keep the distance order.
	const [screenDetails, sectionDetails] = await Promise.all([
		rows<SemanticScreenHit>(
			`SELECT id, site, site.name AS siteName, viewport, path, title, page_type AS pageType,
				description, media.thumb AS thumb, width, height
			 FROM screen WHERE id IN $ids`,
			{ ids: screenMatches.map((match) => new RecordId('screen', match.id)) }
		),
		rows<SemanticSectionHit>(
			`SELECT id, site, site.name AS siteName, screen, screen.path AS screenPath, viewport,
				label, name, media, rect
			 FROM element WHERE id IN $ids`,
			{ ids: sectionMatches.map((match) => new RecordId('element', match.id)) }
		)
	]);
	const screenById = new Map(screenDetails.map((screen) => [screen.id, screen]));
	const sectionById = new Map(sectionDetails.map((section) => [section.id, section]));
	return {
		screens: screenMatches.flatMap((match) => screenById.get(match.id) ?? []),
		sections: sectionMatches.flatMap((match) => sectionById.get(match.id) ?? [])
	};
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
	flowCounts: Record<Viewport, number>;
	kindCounts: Record<Viewport, Partial<Record<ElementKind, number>>>;
	/** The goals exploration is trying right now, by viewport and then worker. */
	liveGoals: LiveGoal[];
}

/**
 * A live goal reports after every step, which takes seconds. One that has been silent this long
 * belongs to a crawler that died without cleaning up, so it is not shown.
 */
const LIVE_GOAL_MAX_AGE = '2m';

export async function getSiteOverview(slug: string): Promise<SiteOverview | undefined> {
	const [site] = await rows<Site>('SELECT * FROM site WHERE slug = $slug LIMIT 1', { slug });
	if (!site) return undefined;
	const siteRecord = new RecordId('site', site.id);

	const [crawls, screenGroups, flowGroups, liveGoals, currentCrawls] = await Promise.all([
		rows<Crawl>('SELECT * FROM crawl WHERE site = $site ORDER BY created_at DESC LIMIT 20', {
			site: siteRecord
		}),
		// Counted from the screen table rather than `crawl.screens` so it is right even while the
		// crawler's counters lag behind.
		rows<{ crawl: string; count: number }>(
			'SELECT crawl, count() AS count FROM screen WHERE site = $site GROUP BY crawl',
			{ site: siteRecord }
		),
		rows<{ crawl: string; count: number }>(
			'SELECT crawl, count() AS count FROM flow WHERE site = $site GROUP BY crawl',
			{ site: siteRecord }
		),
		// The screenshot is left out: it is large and the panel fetches it as an image.
		rows<LiveGoal>(
			`SELECT * OMIT screenshot FROM live_goal
			 WHERE site = $site AND updated_at > time::now() - <duration> $maxAge
			 ORDER BY viewport, slot`,
			{ site: siteRecord, maxAge: LIVE_GOAL_MAX_AGE }
		),
		db().then((database) => sourceCrawls(database, site.id))
	]);

	const screensByCrawl = new Map(screenGroups.map((group) => [group.crawl, group.count]));
	const flowsByCrawl = new Map(flowGroups.map((group) => [group.crawl, group.count]));
	const sources: SiteOverview['sources'] = {};
	const screenCounts: SiteOverview['screenCounts'] = { desktop: 0, mobile: 0 };
	const flowCounts: SiteOverview['flowCounts'] = { desktop: 0, mobile: 0 };
	for (const crawl of currentCrawls) {
		sources[crawl.viewport] = crawl.id;
		screenCounts[crawl.viewport] = screensByCrawl.get(crawl.id) ?? 0;
		flowCounts[crawl.viewport] = flowsByCrawl.get(crawl.id) ?? 0;
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

	return { site, crawls, sources, screenCounts, flowCounts, kindCounts, liveGoals };
}

/** The JPEG of a live goal's browser after its last step, or undefined once the goal has ended. */
export async function getLiveGoalScreenshot(goalId: string): Promise<Uint8Array | undefined> {
	const [goal] = await rows<{ screenshot?: Uint8Array }>(
		'SELECT screenshot FROM live_goal WHERE id = $goal',
		{ goal: new RecordId('live_goal', goalId) }
	);
	return goal?.screenshot;
}

export interface ScreenList {
	screens: Screen[];
	/** Screens per page type in the whole crawl, whatever filter is active; the chips' counts. */
	pageTypeCounts: Partial<Record<string, number>>;
}

/**
 * Screens of one crawl in capture order, optionally of one page type.
 *
 * A state (a modal or menu open on a page) is typed by the model from its overlay, which is
 * unreliable: a pricing page's "contact sales" dialog comes back as "contact", and its mobile menu
 * as "other". So a state counts as the type of the page it was opened on, and the filter keeps
 * the states that hang off a matching page along with that page. Filtering to pages only would
 * hide half of what a pricing page shows; trusting the overlay would scatter them.
 */
export async function listScreens(crawlId: string, pageType?: string): Promise<ScreenList> {
	const crawl = new RecordId('crawl', crawlId);
	const [screens, parents] = await Promise.all([
		rows<Screen>('SELECT * OMIT embedding FROM screen WHERE crawl = $crawl ORDER BY seq', {
			crawl
		}),
		rows<{ state: string; pageType?: string }>(
			`SELECT out AS state, in.page_type AS pageType FROM action
			 WHERE crawl = $crawl AND in.kind = 'page' AND out.kind = 'state'`,
			{ crawl }
		)
	]);

	// A state reached from several pages takes the type of the first one.
	const parentType = new Map<string, string | undefined>();
	for (const parent of parents) {
		if (!parentType.has(parent.state)) parentType.set(parent.state, parent.pageType);
	}
	const effectiveType = (screen: Screen) =>
		screen.kind === 'state' ? parentType.get(screen.id) : screen.page_type;

	const pageTypeCounts: ScreenList['pageTypeCounts'] = {};
	for (const screen of screens) {
		const type = effectiveType(screen);
		if (type !== undefined) pageTypeCounts[type] = (pageTypeCounts[type] ?? 0) + 1;
	}
	return {
		screens:
			pageType === undefined
				? screens
				: screens.filter((screen) => effectiveType(screen) === pageType),
		pageTypeCounts
	};
}

/** Sections per label across the given crawls; the counts behind the label chips. */
async function countSectionLabels(
	crawls: RecordId[],
	viewport?: Viewport
): Promise<Partial<Record<string, number>>> {
	const { conditions, variables } = elementConditions({ kind: 'section', viewport }, crawls);
	const groups = await rows<{ label?: string; count: number }>(
		`SELECT label, count() AS count FROM element WHERE ${conditions.join(' AND ')} GROUP BY label`,
		variables
	);
	const counts: Partial<Record<string, number>> = {};
	for (const group of groups) {
		// Sections the model hasn't labelled yet only show under "All".
		if (group.label !== undefined) counts[group.label] = group.count;
	}
	return counts;
}

export interface ElementListItem extends UiElement {
	/** Capture order of the owning screen, used to keep the listing in page order. */
	screen_seq: number;
	screen_path: string;
}

export interface ElementList {
	elements: ElementListItem[];
	/** Sections per label in the crawl, whatever label is active. */
	labelCounts: Partial<Record<string, number>>;
}

/** Elements of one crawl, optionally of one kind and, for sections, one label, in page order. */
export async function listElements(
	crawlId: string,
	criteria: { kind?: ElementKind; label?: SectionLabel }
): Promise<ElementList> {
	const crawls = [new RecordId('crawl', crawlId)];
	const { conditions, variables } = elementConditions(
		// A label only exists on sections, so another kind would match nothing.
		{ kind: criteria.kind, label: criteria.kind === 'section' ? criteria.label : undefined },
		crawls
	);
	const [elements, labelCounts] = await Promise.all([
		rows<ElementListItem>(
			`SELECT *, screen.seq AS screen_seq, screen.path AS screen_path OMIT embedding FROM element
			 WHERE ${conditions.join(' AND ')}
			 ORDER BY screen_seq, rect.y
			 LIMIT 400`,
			variables
		),
		criteria.kind === 'section' ? countSectionLabels(crawls) : {}
	]);
	return { elements, labelCounts };
}

// ---------------------------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------------------------

/**
 * The flows of one crawl in the order the flow tree shows them: grouped by category in the
 * model's vocabulary order, then in the order they were cut. A category the vocabulary doesn't
 * know sorts after the known ones, and flows without a category come last.
 */
export async function listFlows(crawlId: string): Promise<Flow[]> {
	const flows = await rows<Flow>(
		'SELECT * FROM flow WHERE crawl = $crawl ORDER BY created_at, id',
		{
			crawl: new RecordId('crawl', crawlId)
		}
	);
	const rank = (flow: Flow) => {
		if (flow.category === undefined) return FLOW_CATEGORIES.length + 1;
		const index = (FLOW_CATEGORIES as readonly string[]).indexOf(flow.category);
		return index === -1 ? FLOW_CATEGORIES.length : index;
	};
	// Array.sort is stable, so flows of one category keep their creation order.
	return flows.sort((first, second) => rank(first) - rank(second));
}

export interface FlowStepDetail {
	screen: Pick<Screen, 'id' | 'viewport' | 'path' | 'title' | 'kind' | 'width' | 'height'> & {
		thumb: string;
	};
	caption?: string;
	/** What was clicked or followed to get here; missing on the first step and on unlabelled links. */
	actionLabel?: string;
	actionKind?: 'navigate' | 'click';
}

/** A flow's steps with the screen and action each one points at, in flow order. */
export async function getFlowSteps(flow: Flow): Promise<FlowStepDetail[]> {
	const [screens, actions] = await Promise.all([
		rows<FlowStepDetail['screen']>(
			'SELECT id, viewport, path, title, kind, width, height, media.thumb AS thumb FROM screen WHERE id IN $ids',
			{ ids: flow.steps.map((step) => new RecordId('screen', step.screen)) }
		),
		rows<{ id: string; label: string; kind: 'navigate' | 'click' }>(
			'SELECT id, label, kind FROM action WHERE id IN $ids',
			{
				ids: flow.steps.flatMap((step) =>
					step.action === undefined ? [] : [new RecordId('action', step.action)]
				)
			}
		)
	]);
	const screenById = new Map(screens.map((screen) => [screen.id, screen]));
	const actionById = new Map(actions.map((action) => [action.id, action]));
	// A screen deleted after the flow was cut leaves a dangling step; the row simply skips it.
	return flow.steps.flatMap((step) => {
		const screen = screenById.get(step.screen);
		if (screen === undefined) return [];
		const action = step.action === undefined ? undefined : actionById.get(step.action);
		return [
			{
				screen,
				caption: step.caption,
				actionLabel: action?.label || undefined,
				actionKind: action?.kind
			}
		];
	});
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
	/** Sections per label in the viewport, across all sites; empty unless the kind is `section`. */
	labelCounts: Partial<Record<string, number>>;
}

/** Elements of every site's current crawl in one viewport, optionally of one kind and label. */
export async function listLibrary(
	criteria: { viewport: Viewport; kind?: ElementKind; label?: SectionLabel },
	limit: number
): Promise<Library> {
	const crawls = (await sourceCrawls(await db()))
		.filter((crawl) => crawl.viewport === criteria.viewport)
		.map((crawl) => new RecordId('crawl', crawl.id));
	const inViewport = elementConditions({ viewport: criteria.viewport }, crawls);
	// A label only exists on sections, so another kind would match nothing.
	const filtered = elementConditions(
		{ ...criteria, label: criteria.kind === 'section' ? criteria.label : undefined },
		crawls
	);

	const [elements, kindGroups, labelCounts] = await Promise.all([
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
		),
		criteria.kind === 'section' ? countSectionLabels(crawls, criteria.viewport) : {}
	]);

	const kindCounts: Library['kindCounts'] = {};
	for (const group of kindGroups) kindCounts[group.kind] = group.count;
	return {
		elements: elements.slice(0, limit),
		hasMore: elements.length > limit,
		kindCounts,
		labelCounts
	};
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
