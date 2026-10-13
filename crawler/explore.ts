// Goal-directed exploration. After a crawl has mapped a site and the models have described its
// pages, the model lists what a visitor could want to do on each page, the lists are merged into
// one set of distinct goals, and every goal is then tried in a fresh browser: screenshot, ask the
// model for the next action, carry it out, capture the screen it leads to. Each attempt is saved
// as a flow, whether it reached its goal or not, with a video recorded while it ran.
//
// `bun crawler/explore.ts [site-slug] [--viewport desktop|mobile] [--max-trajectories N]` explores
// the current crawls of one site, or of every site. Run `bun run enrich` first, so the pages have
// types and descriptions to plan from.
import { parseArgs } from 'node:util';
import type { Browser, Page } from 'playwright';
import type { Surreal } from 'surrealdb';
import { sourceCrawls } from '#lib/server/library.ts';
import { configFromEnv, connect, RecordId } from '#lib/server/surreal.ts';
import {
	VIEWPORTS,
	type FlowOutcome,
	type FlowVideo,
	type Rect,
	type Viewport
} from '#lib/types.ts';
import {
	acceptCookieBanner,
	captureScreen,
	type CaptureRequest,
	closeBrowser,
	computeDomSig,
	dHash,
	hammingDistance,
	launchBrowser,
	loadPage,
	newId,
	openContext,
	stabilizeLoadedPage,
	viewportScreenshot
} from './capture.ts';
import {
	carryOut,
	decideNextAction,
	describeAction,
	refusalReason,
	resolveTarget,
	settle,
	type AgentAction,
	type HistoryEntry
} from './agent.ts';
import {
	COVERED_GOAL_SIMILARITY,
	cosineSimilarity,
	loadMappedPages,
	loadNavLabels,
	mergeGoals,
	planGoals,
	type MappedPage,
	type PlannedGoal
} from './goals.ts';
import {
	createCrawlContext,
	CrawlCancelled,
	SAME_STATE_HASH_DISTANCE,
	STATE_HASH_DISTANCE,
	type CrawlContext
} from './crawl.ts';
import type { CrawlJob } from './jobs.ts';
import type { ProbedControl } from './page.ts';
import { setFlowVideo, startRecording } from './recording.ts';
import { displayPath, isSameSite, normalizeUrl, urlKey } from './rules.ts';

/** Same as the schema default of `crawl.max_trajectories`, for crawls from before the field existed. */
export const DEFAULT_MAX_TRAJECTORIES = 100;

/**
 * Goals (and planning requests) in flight at the same time, `EXPLORE_CONCURRENCY` to change it. One
 * is right for llama.cpp on a single local card, which answers one request at a time, so more
 * browsers would only wait on it. A vLLM server batches requests, and with it 4 or more keep the
 * model busy while the browsers wait on pages.
 */
const DEFAULT_CONCURRENCY = Number(process.env.EXPLORE_CONCURRENCY ?? 1);

interface KnownScreen {
	id: string;
	url: string;
	imageHash: string;
	domSig: string;
	depth: number;
	kind: 'page' | 'state';
}

/**
 * The screens of the crawl, and how to tell which of them the browser is showing. A trajectory
 * that reaches a stored screen again reuses it; only a screen nobody has seen is captured.
 */
class ScreenIndex {
	constructor(private readonly screens: KnownScreen[]) {}

	get(id: string): KnownScreen {
		return this.screens.find((screen) => screen.id === id)!;
	}

	/**
	 * The screen the page shows now, after an action that started from `previous`. Captured when
	 * it is new. The look is judged at the top of the page, as when the crawler captured pages, so
	 * scrolling alone never makes a screen.
	 */
	async observe(
		ctx: CrawlContext,
		page: Page,
		previous: KnownScreen,
		textBefore: string
	): Promise<KnownScreen> {
		const url = normalizeUrl(page.url())!;
		const scrollY = await page.evaluate(() => {
			const position = window.scrollY;
			window.scrollTo({ top: 0, behavior: 'instant' });
			return position;
		});
		const imageHash = await dHash(await viewportScreenshot(page));
		const domSig = await computeDomSig(page);

		let screen: KnownScreen | undefined;
		if (urlKey(previous.url) !== urlKey(url)) {
			// A page is recognised by its address and a looser look: a hero animation or a banner
			// that was not there when the crawler came by must not make it a new page.
			screen = this.screens.find(
				(known) =>
					known.kind === 'page' &&
					urlKey(known.url) === urlKey(url) &&
					hammingDistance(known.imageHash, imageHash) < STATE_HASH_DISTANCE
			);
		} else {
			// The page did not change, but something on it may have: a menu, a dialog, a tab. Those
			// change the structure of the page (and often only a few pixels of the viewport).
			// The text is compared instead of the look, because heroes with a video or a 3D animation
			// change the look all the time (resend.com's rotating cube did), while a menu or a tab
			// always changes what the page says.
			const newPanels = await page.evaluate(() => window.pageInspector!.newPanels());
			const openedPanel = newPanels.some((panel) => panel.hasPanelRole);
			const textAfter = await page.evaluate(() => document.body.innerText);
			const changed = openedPanel || domSig !== previous.domSig || textAfter !== textBefore;
			screen = changed
				? this.screens.find(
						(known) =>
							known.kind === 'state' &&
							urlKey(known.url) === urlKey(url) &&
							known.domSig === domSig &&
							hammingDistance(known.imageHash, imageHash) < SAME_STATE_HASH_DISTANCE
					)
				: previous;
			if (screen === undefined) {
				screen = await this.capture(ctx, page, {
					kind: 'state',
					url,
					depth: previous.depth,
					domSig,
					newPanels
				});
			}
		}
		if (screen === undefined) {
			screen = await this.capture(ctx, page, {
				kind: 'page',
				url,
				depth: previous.depth + 1,
				domSig
			});
		}
		if (scrollY > 0) {
			await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), scrollY);
		}
		return screen;
	}

	private async capture(
		ctx: CrawlContext,
		page: Page,
		request: Pick<CaptureRequest, 'kind' | 'url' | 'depth' | 'domSig' | 'newPanels'>
	): Promise<KnownScreen> {
		const captured = await captureScreen({ page, ctx, ...request });
		const screen: KnownScreen = {
			id: captured.id,
			url: request.url,
			imageHash: captured.imageHash,
			domSig: request.domSig,
			depth: request.depth,
			kind: request.kind
		};
		this.screens.push(screen);
		return screen;
	}
}

// --- one trajectory ----------------------------------------------------------------------------

/**
 * Past 15 steps the model is wandering: in the closed-loop evaluation in ml/eval, goals that were
 * reached took 2 to 12 steps in all but two long docs searches, and a step costs about 5 s here.
 */
const MAX_STEPS_PER_GOAL = 15;
/** Steps in a row that change nothing before the run is called stuck. The prompt warns after 3. */
const STUCK_AFTER_UNCHANGED_STEPS = 4;
/** Reaching the same screen this often means the model is going round in circles. */
const STUCK_AFTER_VISITS = 3;
/** A viewport whose dHash moved by this many bits has visibly changed, even if the screen is the same. */
const SMALL_VIEW_CHANGE = 4;

interface TrajectoryStep {
	screen: string;
	/** The action that led here; missing on the first step. */
	action?: RecordId;
	thought?: string;
}

interface Trajectory {
	steps: TrajectoryStep[];
	outcome: FlowOutcome;
	reason: string;
	/** The recording of the run, or undefined when the run is not worth keeping. */
	video?: FlowVideo;
}

/**
 * A run that never left its start page is only kept when it ends with one of these verdicts. "Done"
 * is not among them: the goal was already satisfied by the page itself, which the library has.
 */
const VERDICT_OUTCOMES: FlowOutcome[] = ['gave_up', 'blocked'];

/** Runs one goal in a fresh browser context, from its start page until it ends one way or another. */
async function runTrajectory(
	browser: Browser,
	ctx: CrawlContext,
	screenIndex: ScreenIndex,
	goal: PlannedGoal,
	startPage: MappedPage,
	flowId: string,
	goalNumber: number
): Promise<Trajectory> {
	const { context } = await openContext(browser, ctx.job.viewport);
	try {
		const page = await context.newPage();
		// Pop-ups (target=_blank links, OAuth windows) are never wanted; native dialogs would block the page.
		context.on('page', (popup) => {
			if (popup !== page) void popup.close();
		});
		page.on('dialog', (dialog) => void dialog.dismiss());
		// Submitting a form (signing up, subscribing, paying) is a POST navigation. Whatever the model
		// presses, it never goes through. Routes added last run first; `fallback` hands on to the
		// blocking of analytics hosts that `openBrowser` set up.
		await context.route('**/*', (route) => {
			const request = route.request();
			if (request.method() === 'POST' && request.resourceType() === 'document')
				return route.abort();
			return route.fallback();
		});

		await loadPage(page, startPage.url, { waitForBanner: true });
		const recording = await startRecording(page, ctx.job.viewport);
		// The first step is the page the goal was planned from, whatever animation the hero is in.
		let current = screenIndex.get(startPage.id);
		recording.markStep();

		const steps: TrajectoryStep[] = [{ screen: current.id }];
		const history: HistoryEntry[] = [];
		const visits = new Map<string, number>([[current.id, 1]]);
		let unchangedSteps = 0;

		// The recording is finished here, while the browser is still open.
		const ended = async (outcome: FlowOutcome, reason: string): Promise<Trajectory> => {
			const isKept = steps.length > 1 || VERDICT_OUTCOMES.includes(outcome);
			const video = isKept
				? await recording.finish({ media: ctx.media, site: ctx.siteId, flowId })
				: undefined;
			return { steps, outcome, reason, video };
		};

		for (let stepNumber = 1; stepNumber <= MAX_STEPS_PER_GOAL; stepNumber++) {
			await ctx.throwIfStopped();
			const startedAt = performance.now();
			const action = await decideNextAction(goal.goal, page, history);
			const decidedIn = ((performance.now() - startedAt) / 1000).toFixed(1);
			console.log(
				`    #${goalNumber} step ${stepNumber}: ${describeAction(action)} (${decidedIn} s) ${action.thought}`
			);
			if (action.action === 'done') return await ended('done', action.reason);
			if (action.action === 'give_up') return await ended('gave_up', action.reason);

			const aimsAtPoint = action.action === 'click' || action.action === 'type';
			let control: ProbedControl | undefined;
			if (aimsAtPoint) {
				const point = resolveTarget(action.target);
				control = await page.evaluate(({ x, y }) => window.pageInspector!.probeAt(x, y), point);
				const refusal = refusalReason(control, action.element, ctx.site.host);
				if (refusal !== undefined) return await ended('blocked', refusal);
			}

			const urlBefore = page.url();
			const hashBefore = await dHash(await viewportScreenshot(page));
			await page.evaluate(() => window.pageInspector!.snapshotVisible());
			const textBefore = await page.evaluate(() => document.body.innerText);
			const refusal = await carryOut(page, action, recording);
			if (refusal !== undefined) return await ended('blocked', refusal);
			await settle(page);

			const destination = normalizeUrl(page.url());
			if (destination === undefined || !isSameSite(destination, ctx.site.host)) {
				return await ended(
					'blocked',
					`"${describeAction(action)}" led away from the site, to ${page.url()}`
				);
			}

			const urlChanged = urlKey(destination) !== urlKey(urlBefore);
			if (urlChanged) {
				await acceptCookieBanner(page, { waitForBanner: false });
				await stabilizeLoadedPage(page);
				await recording.restorePointer();
			}
			const hashAfter = await dHash(await viewportScreenshot(page));
			const viewChanged = hammingDistance(hashBefore, hashAfter) >= SMALL_VIEW_CHANGE;

			// Scrolling and waiting do not change what the page is, unless a redirect moved it.
			const mayHaveChangedScreen = urlChanged || aimsAtPoint;
			const reached = mayHaveChangedScreen
				? await screenIndex.observe(ctx, page, current, textBefore)
				: current;
			const movedToAnotherScreen = reached.id !== current.id;
			if (movedToAnotherScreen) {
				const actionId = await recordAction(ctx, current, reached, action, control);
				steps.push({ screen: reached.id, action: actionId, thought: action.thought });
				recording.markStep();
				visits.set(reached.id, (visits.get(reached.id) ?? 0) + 1);
				current = reached;
			}

			const result = urlChanged
				? `now at ${displayPath(destination)}`
				: movedToAnotherScreen || viewChanged
					? 'the page changed'
					: 'nothing changed';
			history.push({ action: describeAction(action), result });
			unchangedSteps = result === 'nothing changed' ? unchangedSteps + 1 : 0;

			if (unchangedSteps >= STUCK_AFTER_UNCHANGED_STEPS) {
				return await ended(
					'stuck',
					`${unchangedSteps} actions in a row changed nothing on the page`
				);
			}
			if ((visits.get(current.id) ?? 0) >= STUCK_AFTER_VISITS) {
				return await ended('stuck', `it kept coming back to ${displayPath(current.url)}`);
			}
		}
		return await ended(
			'step_limit',
			`${MAX_STEPS_PER_GOAL} steps were not enough to reach the goal, so the attempt was cut off`
		);
	} finally {
		await closeBrowser(context);
	}
}

/** Stores the edge from one screen to the next, or finds the one an earlier trajectory made. */
async function recordAction(
	ctx: CrawlContext,
	from: KnownScreen,
	to: KnownScreen,
	action: AgentAction,
	control: ProbedControl | undefined
): Promise<RecordId> {
	const label = control?.name || ('element' in action ? action.element : describeAction(action));
	const [existing] = await ctx.db
		.query(
			'SELECT VALUE id FROM action WHERE in = $from AND out = $to AND crawl = $crawl AND label = $label LIMIT 1',
			{
				from: new RecordId('screen', from.id),
				to: new RecordId('screen', to.id),
				crawl: ctx.job.id,
				label
			}
		)
		.collect<[RecordId[]]>();
	if (existing.length > 0) return existing[0];
	return ctx.createAction(
		from.id,
		to.id,
		to.kind === 'page' ? 'navigate' : 'click',
		label,
		control?.region ?? 'other',
		control?.rect as Rect | undefined
	);
}

// --- running a crawl's goals -------------------------------------------------------------------

export interface TrajectoryReport {
	goal: string;
	category: string;
	startPath: string;
	outcome?: FlowOutcome;
	reason?: string;
	steps: number;
	seconds: number;
	/** Why no flow was saved, when none was. */
	notSaved?: string;
}

export interface ExplorationSummary {
	plannedGoals: number;
	distinctGoals: number;
	trajectories: TrajectoryReport[];
	seconds: number;
}

/**
 * Runs one goal and saves it as a flow. A run that breaks (a page that crashed, a model answer that
 * failed) is reported and does not end the exploration.
 */
async function attemptGoal(
	browser: Browser,
	ctx: CrawlContext,
	screenIndex: ScreenIndex,
	goal: PlannedGoal,
	startPage: MappedPage,
	goalNumber: number
): Promise<TrajectoryReport> {
	const report: TrajectoryReport = {
		goal: goal.goal,
		category: goal.category,
		startPath: goal.startPath,
		steps: 0,
		seconds: 0
	};
	const startedAt = performance.now();
	const flowId = newId();
	try {
		const trajectory = await runTrajectory(
			browser,
			ctx,
			screenIndex,
			goal,
			startPage,
			flowId,
			goalNumber
		);
		report.outcome = trajectory.outcome;
		report.reason = trajectory.reason;
		report.steps = trajectory.steps.length - 1;
		console.log(
			`    #${goalNumber} -> ${trajectory.outcome}, ${report.steps} steps: ${trajectory.reason}`
		);
		if (trajectory.video === undefined) {
			report.notSaved = 'it never left the start page, and the verdict was not worth a flow';
		} else {
			await saveFlow(ctx, flowId, goal, trajectory, trajectory.video);
		}
	} catch (error) {
		if (error instanceof CrawlCancelled) throw error;
		report.outcome = 'error';
		report.reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
		report.notSaved = 'the run failed';
		console.warn(`    #${goalNumber} failed: ${report.reason}`);
	}
	report.seconds = (performance.now() - startedAt) / 1000;
	return report;
}

/**
 * Plans goals for a finished, enriched crawl and tries them, at most `max_trajectories` of them
 * (a bound on the run, not a target). New screens, elements and actions land in the same crawl,
 * and every attempt is saved as a flow. Earlier goal flows of the crawl are replaced.
 */
export async function exploreCrawl(
	db: Surreal,
	crawlId: RecordId,
	options: {
		signal?: AbortSignal;
		maxTrajectories?: number;
		concurrency?: number;
		planOnly?: boolean;
	} = {}
): Promise<ExplorationSummary> {
	const startedAt = performance.now();
	const [jobs] = await db.query('SELECT * FROM $id', { id: crawlId }).collect<[CrawlJob[]]>();
	const job = jobs[0];
	if (job === undefined) throw new Error(`There is no crawl ${String(crawlId.id)}.`);
	const bound = options.maxTrajectories ?? job.max_trajectories ?? DEFAULT_MAX_TRAJECTORIES;
	const ctx = await createCrawlContext(db, job, options.signal ?? new AbortController().signal);
	const label = `${ctx.siteId} ${job.viewport}`;

	const pages = await loadMappedPages(db, crawlId, job.finished_at);
	if (pages.length === 0) throw new Error(`Crawl ${String(crawlId.id)} has no pages to plan from.`);
	await ctx.setActivity('Planning what a visitor could do');
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const planned = await planGoals(ctx, pages, await loadNavLabels(db, crawlId), concurrency);
	const goals = await mergeGoals(planned, concurrency);
	console.log(`[${label}] ${planned.length} goals planned, ${goals.length} distinct`);
	for (const goal of goals) console.log(`  [${goal.category}] ${goal.startPath}: ${goal.goal}`);
	if (options.planOnly) {
		await db.query('UPDATE $id SET activity = NONE', { id: crawlId }).collect();
		return {
			plannedGoals: planned.length,
			distinctGoals: goals.length,
			trajectories: [],
			seconds: (performance.now() - startedAt) / 1000
		};
	}

	await db
		.query("DELETE flow WHERE crawl = $crawl AND source = 'goal'", { crawl: crawlId })
		.collect();
	const [known] = await db
		.query('SELECT id, url, image_hash, dom_sig, depth, kind FROM screen WHERE crawl = $crawl', {
			crawl: crawlId
		})
		.collect<
			[
				{
					id: RecordId;
					url: string;
					image_hash: string;
					dom_sig: string;
					depth: number;
					kind: 'page' | 'state';
				}[]
			]
		>();
	const screenIndex = new ScreenIndex(
		known.map((screen) => ({
			id: String(screen.id.id),
			url: screen.url,
			imageHash: screen.image_hash,
			domSig: screen.dom_sig,
			depth: screen.depth,
			kind: screen.kind
		}))
	);

	// Workers take the next goal off the shared queue.
	const queue = [...goals];
	const reports: TrajectoryReport[] = [];
	const reached: PlannedGoal[] = [];
	let started = 0;
	async function work(): Promise<void> {
		for (;;) {
			const goal = queue.shift();
			if (goal === undefined || started >= bound) return;
			const alreadyReached = reached.find(
				(earlier) =>
					earlier.startPath === goal.startPath &&
					cosineSimilarity(earlier.embedding, goal.embedding) >= COVERED_GOAL_SIMILARITY
			);
			if (alreadyReached !== undefined) {
				console.log(`[${label}] skipped, covered by "${alreadyReached.goal}": ${goal.goal}`);
				continue;
			}
			const page = pages.find((candidate) => candidate.path === goal.startPath);
			if (page === undefined) continue;

			started++;
			console.log(
				`[${label}] #${started}/${Math.min(bound, goals.length)} ${goal.goal} [${goal.category}] from ${goal.startPath}`
			);
			const report = await attemptGoal(browser, ctx, screenIndex, goal, page, started);
			if (report.outcome === 'done') reached.push(goal);
			reports.push(report);
		}
	}
	// One browser for all goals, each in a context of its own. Launching a browser per goal made
	// the second launch fail under Bun: Chrome exited a few seconds in and Playwright never noticed.
	const browser = await launchBrowser();
	try {
		await ctx.setActivity('Exploring toward goals');
		await Promise.all(Array.from({ length: concurrency }, work));
	} finally {
		await closeBrowser(browser);
		await db.query('UPDATE $id SET activity = NONE', { id: crawlId }).collect();
	}
	return {
		plannedGoals: planned.length,
		distinctGoals: goals.length,
		trajectories: reports,
		seconds: (performance.now() - startedAt) / 1000
	};
}

/** Stores a trajectory as a goal flow, and its recording as the flow's video. */
async function saveFlow(
	ctx: CrawlContext,
	flowId: string,
	goal: PlannedGoal,
	trajectory: Trajectory,
	video: FlowVideo
): Promise<void> {
	await ctx.db
		.query('CREATE ONLY $id CONTENT $content', {
			id: new RecordId('flow', flowId),
			content: {
				site: ctx.job.site,
				crawl: ctx.job.id,
				viewport: ctx.job.viewport,
				source: 'goal',
				title: goal.goal,
				category: goal.category,
				goal: goal.goal,
				outcome: trajectory.outcome,
				outcome_reason: trajectory.reason,
				steps: trajectory.steps.map((step) => ({
					screen: new RecordId('screen', step.screen),
					action: step.action,
					thought: step.thought
				}))
			}
		})
		.collect();
	await setFlowVideo(ctx.db, flowId, video);
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			viewport: { type: 'string' },
			'max-trajectories': { type: 'string' },
			concurrency: { type: 'string' },
			'plan-only': { type: 'boolean' }
		}
	});
	if (values.viewport !== undefined && !VIEWPORTS.includes(values.viewport as Viewport)) {
		console.error('--viewport must be desktop or mobile');
		process.exit(2);
	}
	const maxTrajectories =
		values['max-trajectories'] === undefined ? undefined : Number(values['max-trajectories']);

	const shutdown = new AbortController();
	process.on('SIGINT', () => shutdown.abort());
	process.on('SIGTERM', () => shutdown.abort());

	const db = await connect(configFromEnv(process.env));
	try {
		const crawls = (await sourceCrawls(db, positionals[0])).filter(
			(crawl) => values.viewport === undefined || crawl.viewport === values.viewport
		);
		if (crawls.length === 0) {
			throw new Error(
				positionals[0] === undefined
					? 'There are no crawls to explore.'
					: `Site "${positionals[0]}" has no crawls.`
			);
		}
		for (const crawl of crawls) {
			const summary = await exploreCrawl(db, new RecordId('crawl', crawl.id), {
				signal: shutdown.signal,
				maxTrajectories,
				concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
				planOnly: values['plan-only']
			});
			console.log(`\n${crawl.site} ${crawl.viewport}: ${JSON.stringify(summary, undefined, 2)}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	} finally {
		await db.close();
	}
	// A browser that failed to close in time would otherwise keep the process alive.
	process.exit();
}
