// Goal-directed exploration. After a crawl has mapped a site and the models have described its
// pages, the model lists what a visitor could want to do on each page, the lists are merged into
// one set of distinct goals, and every goal is then tried in a fresh browser: screenshot, ask the
// model for the next action, carry it out, capture the screen it leads to. Each attempt is saved
// as a flow, whether it reached its goal or not, with a video recorded while it ran.
//
// Before the goals, a site without a usable demo account gets one: the model signs up with a plus
// address of the demo inbox, the verification email is read over IMAP, and the login is saved. The
// pages behind it are then planned from like any others, and goals that need the login start with
// the saved one.
//
// `bun crawler/explore.ts [site-slug] [--viewport desktop|mobile] [--max-trajectories N]` explores
// the current crawls of one site, or of every site. Run `bun run enrich` first, so the pages have
// types and descriptions to plan from.
import { parseArgs } from 'node:util';
import type { Browser } from 'playwright';
import type { Surreal } from 'surrealdb';
import { sourceCrawls } from '#lib/server/library.ts';
import { configFromEnv, connect, RecordId } from '#lib/server/surreal.ts';
import {
	VIEWPORTS,
	type Account,
	type FlowOutcome,
	type FlowVideo,
	type Viewport
} from '#lib/types.ts';
import { failAccount, loadAccount, looksSignedIn, saveLogin, startAccount } from './accounts.ts';
import { closeBrowser, launchBrowser, loadPage, newId, openContext } from './capture.ts';
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
import { createCrawlContext, CrawlCancelled, type CrawlContext } from './crawl.ts';
import { enrichCrawl } from './enrich.ts';
import type { CrawlJob } from './jobs.ts';
import { clearLiveGoals } from './live.ts';
import { mailIsConfigured } from './mail.ts';
import { setFlowVideo } from './recording.ts';
import {
	runTrajectory,
	ScreenIndex,
	type Trajectory,
	type TrajectoryRequest
} from './trajectory.ts';

/** Same as the schema default of `crawl.max_trajectories`, for crawls from before the field existed. */
export const DEFAULT_MAX_TRAJECTORIES = 100;

/**
 * Goals (and planning requests) in flight at the same time, `EXPLORE_CONCURRENCY` to change it. One
 * is right for llama.cpp on a single local card, which answers one request at a time, so more
 * browsers would only wait on it. A vLLM server batches requests, and with it 4 or more keep the
 * model busy while the browsers wait on pages.
 */
const DEFAULT_CONCURRENCY = Number(process.env.EXPLORE_CONCURRENCY ?? 1);

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
	/** The sign-up or login that was needed before the goals, when there was one. */
	login?: TrajectoryReport;
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
	request: Omit<TrajectoryRequest, 'flowId'>
): Promise<{ report: TrajectoryReport; trajectory?: Trajectory }> {
	const { goal, goalNumber } = request;
	const report: TrajectoryReport = {
		goal: goal.goal,
		category: goal.category,
		startPath: goal.startPath,
		steps: 0,
		seconds: 0
	};
	const startedAt = performance.now();
	const flowId = newId();
	let trajectory: Trajectory | undefined;
	try {
		trajectory = await runTrajectory(browser, ctx, screenIndex, { ...request, flowId });
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
	return { report, trajectory };
}

// --- the demo account ---------------------------------------------------------------------------

/** What `establishLogin` leaves behind for the rest of the run. */
interface LoginResult {
	/** The account to use for goals, or undefined when the site has none that works. */
	account?: Account;
	/** The pages the model can plan from behind the login. */
	signedInPages: MappedPage[];
	report?: TrajectoryReport;
}

/**
 * Makes sure the site has a demo account that is logged in, and returns what the run can use of
 * it. A saved login is tried first. When it has expired the model logs in again with the stored
 * password, and when the site has no working account it signs up for one, with a new plus address
 * if an earlier attempt was refused. The model does the forms, the crawler reads the
 * verification email, and the browser's login is saved when the run got in.
 */
async function establishLogin(
	browser: Browser,
	ctx: CrawlContext,
	screenIndex: ScreenIndex,
	pages: MappedPage[],
	existing: Account | undefined
): Promise<LoginResult> {
	if (!mailIsConfigured()) {
		console.warn(`[${ctx.siteId}] REFS_MAIL_ADDRESS is not set, so no account is created`);
		return { signedInPages: [] };
	}

	/**
	 * Opens the site with the saved login and captures what it shows as the first page behind
	 * the login. Says whether the login still works.
	 */
	async function visitWithSavedLogin(account: Account): Promise<string | undefined> {
		const { context } = await openContext(browser, ctx.job.viewport, {
			storageState: account.storage_state
		});
		try {
			const page = await context.newPage();
			await loadPage(page, ctx.site.url, { waitForBanner: true });
			if (!(await looksSignedIn(page))) return undefined;
			return (await screenIndex.observe(ctx, page, undefined, '', true)).id;
		} finally {
			await closeBrowser(context);
		}
	}

	let account = existing;
	let landing: string | undefined;
	if (account?.status === 'active' && account.storage_state !== undefined) {
		landing = await visitWithSavedLogin(account);
		if (landing !== undefined) {
			return await withSignedInPages(ctx, [landing], account);
		}
		console.log(`[${ctx.siteId}] the saved login has expired, logging in again`);
	}

	// Without a working account the site gets a new one. An account whose login merely expired
	// keeps its address and password, which the model types into the login form.
	const loggingInAgain = account?.status === 'active';
	if (!loggingInAgain) account = await startAccount(ctx.db, ctx.siteId, account);
	const goalText = loggingInAgain
		? 'Log in to the existing account and stop once you are signed in'
		: 'Sign up for an account and stop once you are signed in';
	const preferredType = loggingInAgain ? 'login' : 'signup';
	const startPage =
		pages.find((page) => page.pageType === preferredType) ??
		pages.find((page) => page.pageType === 'login' || page.pageType === 'signup') ??
		[...pages].sort((first, second) => first.depth - second.depth)[0];
	const goal: PlannedGoal = {
		goal: goalText,
		category: loggingInAgain ? 'logging_in' : 'signing_up',
		startPath: startPage.path,
		success: 'The page shows the product as a signed-in user sees it.',
		actions: 4,
		signedIn: false,
		embedding: []
	};
	await ctx.setActivity(loggingInAgain ? 'Logging in to the demo account' : 'Signing up');
	const { report, trajectory } = await attemptGoal(browser, ctx, screenIndex, {
		goal,
		startPage,
		goalNumber: 0,
		slot: 0,
		account: account!,
		startSignedIn: false,
		establishesLogin: true
	});
	if (report.outcome === 'error') {
		// The run itself broke (a crashed page, the model service), which says nothing about the site.
		return { signedInPages: [], report };
	}
	if (trajectory?.storageState === undefined) {
		await failAccount(ctx.db, ctx.siteId, report.reason ?? 'the sign-up did not finish');
		return { signedInPages: [], report };
	}
	await saveLogin(ctx.db, ctx.siteId, trajectory.storageState);
	const activeAccount = (await loadAccount(ctx.db, ctx.siteId))!;
	// What the saved login shows at the site's address is a page behind the login too, unless the
	// site shows its marketing page to signed-in users as well.
	landing = await visitWithSavedLogin(activeAccount);
	const seeds = [...trajectory.signedInScreens, ...(landing === undefined ? [] : [landing])];
	return { ...(await withSignedInPages(ctx, seeds, activeAccount)), report };
}

/** Describes the screens captured behind the login, so the model can plan from them. */
async function withSignedInPages(
	ctx: CrawlContext,
	screens: string[],
	account: Account
): Promise<LoginResult> {
	// The new screens have no page type or description yet; planning needs both.
	await enrichCrawl(ctx.db, ctx.job.id);
	const signedInPages = await loadMappedPages(ctx.db, ctx.job.id, undefined, screens);
	return { account, signedInPages };
}

/** Plans the visitor's goals and the goals behind the login, and merges them into one list. */
async function planAndMerge(
	ctx: CrawlContext,
	pages: MappedPage[],
	login: LoginResult,
	concurrency: number
): Promise<{ planned: number; goals: PlannedGoal[] }> {
	const navLabels = await loadNavLabels(ctx.db, ctx.job.id);
	const hasAccount = login.account !== undefined;
	const visitorGoals = await planGoals(ctx, pages, navLabels, concurrency, {
		hasAccount,
		signedIn: false
	});
	const signedInGoals = await planGoals(ctx, login.signedInPages, navLabels, concurrency, {
		hasAccount,
		signedIn: true
	});
	const planned = [...visitorGoals, ...signedInGoals];
	return { planned: planned.length, goals: await mergeGoals(planned, concurrency) };
}

// --- running a crawl's goals -------------------------------------------------------------------

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
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const existingAccount = await loadAccount(db, ctx.siteId);

	if (options.planOnly) {
		// Planning alone never signs up; it plans with the account the site already has.
		await ctx.setActivity('Planning what a visitor could do');
		const login: LoginResult = {
			account: existingAccount?.status === 'active' ? existingAccount : undefined,
			signedInPages: []
		};
		const { planned, goals } = await planAndMerge(ctx, pages, login, concurrency);
		console.log(`[${label}] ${planned} goals planned, ${goals.length} distinct`);
		for (const goal of goals) console.log(`  [${goal.category}] ${goal.startPath}: ${goal.goal}`);
		await db.query('UPDATE $id SET activity = NONE', { id: crawlId }).collect();
		return {
			plannedGoals: planned,
			distinctGoals: goals.length,
			trajectories: [],
			seconds: (performance.now() - startedAt) / 1000
		};
	}

	await db
		.query("DELETE flow WHERE crawl = $crawl AND source = 'goal'", { crawl: crawlId })
		.collect();
	const [known] = await db
		.query(
			'SELECT id, url, image_hash, dom_sig, depth, kind, signed_in FROM screen WHERE crawl = $crawl',
			{ crawl: crawlId }
		)
		.collect<
			[
				{
					id: RecordId;
					url: string;
					image_hash: string;
					dom_sig: string;
					depth: number;
					kind: 'page' | 'state';
					signed_in?: boolean;
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
			kind: screen.kind,
			signedIn: screen.signed_in === true
		}))
	);

	// One browser for all goals, each in a context of its own. Launching a browser per goal made
	// the second launch fail under Bun: Chrome exited a few seconds in and Playwright never noticed.
	const browser = await launchBrowser();
	try {
		const login = await establishLogin(browser, ctx, screenIndex, pages, existingAccount);
		await ctx.setActivity('Planning what a visitor could do');
		const { planned, goals } = await planAndMerge(ctx, pages, login, concurrency);
		console.log(`[${label}] ${planned} goals planned, ${goals.length} distinct`);
		for (const goal of goals) console.log(`  [${goal.category}] ${goal.startPath}: ${goal.goal}`);

		// Workers take the next goal off the shared queue.
		const queue = [...goals];
		const reports: TrajectoryReport[] = [];
		const reached: PlannedGoal[] = [];
		let started = 0;
		async function work(slot: number): Promise<void> {
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
				// Goals behind the login start on pages that were captured logged in.
				const startPages = goal.signedIn ? [...login.signedInPages, ...pages] : pages;
				const startPage = startPages.find((candidate) => candidate.path === goal.startPath);
				if (startPage === undefined) continue;

				started++;
				console.log(
					`[${label}] #${started}/${Math.min(bound, goals.length)} ${goal.goal} [${goal.category}] from ${goal.startPath}`
				);
				const { report } = await attemptGoal(browser, ctx, screenIndex, {
					goal,
					startPage,
					goalNumber: started,
					slot,
					account: login.account,
					startSignedIn: goal.signedIn,
					establishesLogin: false
				});
				if (report.outcome === 'done') reached.push(goal);
				reports.push(report);
			}
		}
		await ctx.setActivity('Exploring toward goals');
		await Promise.all(Array.from({ length: concurrency }, (_worker, slot) => work(slot)));
		return {
			plannedGoals: planned,
			distinctGoals: goals.length,
			login: login.report,
			trajectories: reports,
			seconds: (performance.now() - startedAt) / 1000
		};
	} finally {
		await closeBrowser(browser);
		await clearLiveGoals(db, crawlId);
		await db.query('UPDATE $id SET activity = NONE', { id: crawlId }).collect();
	}
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
				signed_in: trajectory.signedIn ? true : undefined,
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
