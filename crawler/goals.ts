// Setting goals for a crawled site: the model lists what a visitor could want to do on each page,
// and the lists are merged into one set of distinct goals in the order worth trying them.
import type { Surreal } from 'surrealdb';
import { RecordId } from '#lib/server/surreal.ts';
import type { CrawlContext } from './crawl.ts';
import { callModel, ItemSkipped } from './enrich.ts';

/** Goals asked for per page. Most pages support two or three; the model may return fewer. */
const GOALS_PER_PAGE = 5;
/**
 * Pages that offer nothing to plan from, whether or not there is an account: errors and payment,
 * and the login and sign-up forms. With an account those two are covered by the one sign-up or
 * login goal that exploration writes itself; planning from them only produced a second sign-up.
 */
const ALWAYS_UNPLANNED_PAGE_TYPES = ['error', 'checkout', 'cart', 'login', 'signup'];
/**
 * Pages that only exist behind a login. Without an account nothing on them can be tried, and the
 * model only listed goals that type a password. With one they are worth planning from.
 */
const UNPLANNED_PAGE_TYPES_WITHOUT_ACCOUNT = ['onboarding', 'settings', 'dashboard'];
/** The model sees the navigation labels as context, and a long list only costs tokens. */
const MAX_NAV_LABELS = 20;
const MAX_NAV_LABEL_CHARACTERS = 40;
/** The kinds of element that say what a visitor can do on a page, most telling first. */
const INTERACTIVE_KINDS = ['form', 'input', 'dialog', 'menu', 'table', 'nav', 'button'] as const;

export interface MappedPage {
	id: string;
	url: string;
	path: string;
	title: string;
	pageType: string;
	description: string;
	/** Media key of the viewport screenshot. */
	image: string;
	depth: number;
	/** Controls on the page, like `form: Subscribe` or `opens when clicked: Products`. */
	interactiveParts: string[];
}

export interface PlannedGoal {
	goal: string;
	category: string;
	startPath: string;
	/** What the screen shows once the goal is reached. */
	success: string;
	/** How many actions the model thinks the goal takes at least. */
	actions: number;
	/** The goal needs the demo account's login, so its browser starts logged in. */
	signedIn: boolean;
	embedding: number[];
}

/**
 * The pages the crawl captured, with what the models and the crawler know about each. Pages that
 * exploration itself reached on an earlier run were captured after the crawl finished and are left
 * out, or every run would plan from the last one's finds. With `signedInScreens` (screen ids) it
 * loads exactly those instead: the pages exploration captured while logged in, which are the
 * starting points of goals behind the login.
 */
export async function loadMappedPages(
	db: Surreal,
	crawl: RecordId,
	crawlFinishedAt: Date | undefined,
	signedInScreens?: string[]
): Promise<MappedPage[]> {
	const which =
		signedInScreens === undefined
			? 'captured_at <= $capturedBefore AND signed_in IS NONE'
			: 'id IN $screens AND signed_in = true';
	const [pages, elements, clicks] = await db
		.query(
			`SELECT id, url, path, title, page_type, description, media.viewport AS image, depth FROM screen
			 	WHERE crawl = $crawl AND kind = 'page' AND captured_at <= $capturedBefore ORDER BY seq;
			 SELECT screen, kind, name FROM element
			 	WHERE crawl = $crawl AND kind IN $kinds AND name != '';
			 SELECT in AS screen, label FROM action WHERE crawl = $crawl AND kind = 'click' AND label != ''`,
			{ crawl, kinds: INTERACTIVE_KINDS, capturedBefore: crawlFinishedAt ?? new Date() }
		)
		.collect<
			[
				{
					id: RecordId;
					url: string;
					path: string;
					title: string;
					page_type?: string;
					description?: string;
					image: string;
					depth: number;
				}[],
				{ screen: RecordId; kind: (typeof INTERACTIVE_KINDS)[number]; name: string }[],
				{ screen: RecordId; label: string }[]
			]
		>();

	const seenAddresses = new Set<string>();
	const distinctPages = pages.filter((page) => {
		// A sign-up and a landing visit can capture the same page; it is planned from once.
		if (signedInScreens === undefined) return true;
		if (seenAddresses.has(page.url)) return false;
		seenAddresses.add(page.url);
		return true;
	});
	return distinctPages.map((page) => {
		const own = elements
			.filter((element) => String(element.screen.id) === String(page.id.id))
			.sort(
				(first, second) =>
					INTERACTIVE_KINDS.indexOf(first.kind) - INTERACTIVE_KINDS.indexOf(second.kind)
			)
			.map((element) => `${element.kind}: ${element.name}`);
		const opens = clicks
			.filter((click) => String(click.screen.id) === String(page.id.id))
			.map((click) => `opens something when clicked: ${click.label}`);
		return {
			id: String(page.id.id),
			url: page.url,
			path: page.path,
			title: page.title,
			pageType: page.page_type ?? '',
			description: page.description ?? '',
			image: page.image,
			depth: page.depth,
			interactiveParts: [...new Set([...own, ...opens])]
		};
	});
}

/** The main navigation labels the crawl recorded as it followed links in the header. */
export async function loadNavLabels(db: Surreal, crawl: RecordId): Promise<string[]> {
	const [labels] = await db
		.query("SELECT VALUE label FROM action WHERE crawl = $crawl AND region = 'nav'", { crawl })
		.collect<[string[]]>();
	const cleaned = labels
		.map((label) => label.replace(/\s+/g, ' ').trim())
		.filter((label) => label !== '' && label.length <= MAX_NAV_LABEL_CHARACTERS);
	return [...new Set(cleaned)].slice(0, MAX_NAV_LABELS);
}

/** Runs `work` over the items with at most `limit` in flight, and returns the results in item order. */
export async function mapConcurrently<Item, Result>(
	items: Item[],
	limit: number,
	work: (item: Item) => Promise<Result>
): Promise<Result[]> {
	const results: Result[] = new Array(items.length);
	let nextIndex = 0;
	async function worker(): Promise<void> {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await work(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/**
 * Asks the model, page by page, what a visitor starting there could want to do. `account` says
 * the site has a demo account, which lets the model plan goals behind the login; `signedIn` says
 * the pages are the ones a logged-in user sees.
 */
export async function planGoals(
	ctx: CrawlContext,
	pages: MappedPage[],
	navLabels: string[],
	concurrency: number,
	options: { hasAccount: boolean; signedIn: boolean }
): Promise<Omit<PlannedGoal, 'embedding'>[]> {
	const siteMap = JSON.stringify(
		pages.map((page) => ({ path: page.path, page_type: page.pageType, title: page.title }))
	);
	const unplannedTypes = options.hasAccount
		? ALWAYS_UNPLANNED_PAGE_TYPES
		: [...ALWAYS_UNPLANNED_PAGE_TYPES, ...UNPLANNED_PAGE_TYPES_WITHOUT_ACCOUNT];
	const plannedPages = pages.filter((page) => !unplannedTypes.includes(page.pageType));
	const goalsPerPage = await mapConcurrently(plannedPages, concurrency, async (page) => {
		await ctx.throwIfStopped();
		const image = await ctx.media.get(page.image);
		if (image === undefined) return [];
		const form = new FormData();
		form.set(
			'image',
			new Blob([image as Uint8Array<ArrayBuffer>], { type: 'image/webp' }),
			'page.webp'
		);
		form.set('site_name', ctx.site.name);
		form.set('host', ctx.site.host);
		form.set('path', page.path);
		form.set('page_type', page.pageType);
		form.set('title', page.title);
		form.set('description', page.description);
		form.set('interactive_parts', JSON.stringify(page.interactiveParts));
		form.set('site_pages', siteMap);
		form.set('nav_labels', JSON.stringify(navLabels));
		form.set('viewport', ctx.job.viewport);
		form.set('max_goals', String(GOALS_PER_PAGE));
		form.set('has_account', String(options.hasAccount));
		form.set('signed_in', String(options.signedIn));
		try {
			const plan = await callModel<{
				goals: {
					goal: string;
					category: string;
					start_path: string;
					success: string;
					actions: number;
					signed_in: boolean;
				}[];
			}>('/plan-goals', form);
			return plan.goals.map((planned) => ({
				goal: planned.goal,
				category: planned.category,
				startPath: planned.start_path,
				success: planned.success,
				actions: planned.actions,
				signedIn: planned.signed_in
			}));
		} catch (error) {
			// The model produced no usable plan for this page; the other pages still get theirs.
			if (!(error instanceof ItemSkipped)) throw error;
			console.warn(`  no goals for ${page.path}: ${error.message}`);
			return [];
		}
	});
	return goalsPerPage.flat();
}

// --- merging goals -----------------------------------------------------------------------------

/**
 * What the embedder is told goals are for. With its default instruction every goal on one site
 * looked alike (0.7 to 0.9 cosine, whatever they asked for, because they all mention the site).
 * Asking it to find the goal that means the same thing separated ten hand-picked pairs: rewordings
 * of one goal scored 0.64 to 0.87, goals that differ 0.24 to 0.55.
 */
const GOAL_EMBEDDING_INSTRUCTION =
	'Given a goal on a website, find the goal that means the same thing.';

/**
 * Two goals at least this similar (cosine) count as one. Chosen from the 66 goals planned for
 * linear.app: pairs from 0.78 up were almost all rewordings ("Compare the pricing plans" and
 * "Check the pricing page to compare different plans"), while between 0.7 and 0.78 rewordings and
 * different goals mix. Merging goals that differ loses coverage, while a repeated goal merely costs
 * a minute of browsing, so the threshold stays on the high side.
 */
const DUPLICATE_GOAL_SIMILARITY = 0.78;

/**
 * Looser than the duplicate threshold, for the run itself: a goal this similar to one that an
 * earlier trajectory reached from the same start page is already covered, and trying it again would
 * mostly repeat the same first steps. Only goals that start on the same page are compared, which is
 * why it can be lower.
 */
export const COVERED_GOAL_SIMILARITY = 0.72;

export function cosineSimilarity(first: number[], second: number[]): number {
	// The embedding service returns unit vectors, so the dot product is the cosine.
	let sum = 0;
	for (let i = 0; i < first.length; i++) sum += first[i] * second[i];
	return sum;
}

/**
 * Drops the goals that repeat an earlier one and orders the rest so that a run which hits its bound
 * has covered as many different things as possible.
 */
export function selectDistinctGoals(goals: PlannedGoal[]): PlannedGoal[] {
	// When two goals are the same, the one that takes more actions is the more instructive to watch.
	const distinct: PlannedGoal[] = [];
	for (const goal of [...goals].sort((first, second) => second.actions - first.actions)) {
		const repeatsKept = distinct.some(
			(kept) => cosineSimilarity(kept.embedding, goal.embedding) >= DUPLICATE_GOAL_SIMILARITY
		);
		if (!repeatsKept) distinct.push(goal);
	}

	// The next goal is the one whose category and start page are least represented among those
	// picked so far; then the longer one, since a one-click goal only repeats the navigation the
	// crawl captured; then the one least like anything picked already.
	const ordered: PlannedGoal[] = [];
	const remaining = [...distinct];
	while (remaining.length > 0) {
		const ranked = remaining
			.map((goal) => ({
				goal,
				represented: ordered.filter(
					(picked) => picked.category === goal.category || picked.startPath === goal.startPath
				).length,
				nearestPicked: Math.max(
					-1,
					...ordered.map((picked) => cosineSimilarity(picked.embedding, goal.embedding))
				)
			}))
			.sort(
				(first, second) =>
					first.represented - second.represented ||
					second.goal.actions - first.goal.actions ||
					first.nearestPicked - second.nearestPicked
			);
		ordered.push(ranked[0].goal);
		remaining.splice(remaining.indexOf(ranked[0].goal), 1);
	}
	return ordered;
}

/** Embeds the goals, so that `selectDistinctGoals` can tell which ones mean the same. */
export async function mergeGoals(
	goals: Omit<PlannedGoal, 'embedding'>[],
	concurrency: number
): Promise<PlannedGoal[]> {
	const embedded = await mapConcurrently(goals, concurrency, async (goal) => {
		const form = new FormData();
		form.set('text', goal.goal);
		form.set('instruction', GOAL_EMBEDDING_INSTRUCTION);
		const { vector } = await callModel<{ vector: number[] }>('/embed', form);
		return { ...goal, embedding: vector };
	});
	return selectDistinctGoals(embedded);
}
