// Exploring a site toward flows. After the landing page is captured, the model plans the flows
// worth recording (goals.ts) and every flow is tried in a fresh browser context: screenshot, ask
// the model for the next action, carry it out, capture the screen it leads to. Each attempt is
// saved as a flow, whether it reached its goal or not, with a video recorded while it ran.
//
// Before the flows, a site without a usable demo account gets one: the model signs up with a plus
// address of the demo inbox, the verification email is read over IMAP, and the login is saved. The
// signed-in landing page is then planned from like the visitor's, and flows that need the login
// start with the saved one. A new account that lands in the product's onboarding goes through it
// first, as a flow of its own, so the plan starts from the product itself.
import type { Browser, Page } from 'playwright';
import { RecordId } from '#lib/server/surreal.ts';
import type { Account, FlowOutcome } from '#lib/types.ts';
import { failAccount, loadAccount, looksSignedIn, saveLogin, startAccount } from './accounts.ts';
import { closeBrowser, loadPage, newId, openContext, viewportScreenshot } from './capture.ts';
import { CrawlCancelled, type CrawlContext } from './crawl.ts';
import {
	interleave,
	planFlows,
	readLandingPage,
	type LandingPage,
	type PlannedFlow
} from './goals.ts';
import { mailIsConfigured } from './mail.ts';
import { setFlowVideo } from './recording.ts';
import {
	runTrajectory,
	StartPageUnavailable,
	type KnownScreen,
	type ScreenIndex,
	type Trajectory
} from './trajectory.ts';

/** Same as the schema default of `crawl.max_trajectories`, for crawls from before the field existed. */
export const DEFAULT_MAX_TRAJECTORIES = 100;

/**
 * Flows in flight at the same time, `EXPLORE_CONCURRENCY` to change it. One is right for
 * llama.cpp on a single local card, which answers one request at a time, so more browsers would
 * only wait on it. A vLLM server batches requests, and with it 4 or more keep the model busy while
 * the browsers wait on pages.
 */
const DEFAULT_CONCURRENCY = Number(process.env.EXPLORE_CONCURRENCY ?? 1);

/** A landing page of the site as one login state sees it: the stored screen and what the planner reads. */
export interface Landing {
	screen: KnownScreen;
	page: LandingPage;
	/** The viewport screenshot, which the planner looks at. */
	image: Buffer;
}

/** Captures the page the browser shows as the landing screen of a login state, and reads it for planning. */
export async function captureLanding(
	ctx: CrawlContext,
	page: Page,
	screenIndex: ScreenIndex,
	signedIn: boolean
): Promise<Landing> {
	const screen = await screenIndex.observe(ctx, page, undefined, '', signedIn);
	return {
		screen,
		page: await readLandingPage(page, ctx.site.host),
		image: await viewportScreenshot(page)
	};
}

export interface FlowReport {
	goal: string;
	category: string;
	startUrl: string;
	outcome?: FlowOutcome;
	reason?: string;
	steps: number;
	seconds: number;
	/** Why no flow was saved, when none was. */
	notSaved?: string;
}

export interface ExplorationSummary {
	plannedFlows: number;
	/** The sign-up or login that was needed before the flows, when there was one. */
	login?: FlowReport;
	/** The onboarding the account went through before the flows, when it landed in one. */
	onboarding?: FlowReport;
	flows: FlowReport[];
	seconds: number;
}

/**
 * Runs one flow and saves it. A run that breaks (a page that crashed, a model answer that failed)
 * is reported and does not end the exploration. A start page the model guessed that does not exist
 * sends the run to the landing page instead, because the goal can still be tried from there.
 */
export async function attemptFlow(
	browser: Browser,
	ctx: CrawlContext,
	screenIndex: ScreenIndex,
	flow: PlannedFlow,
	options: {
		source: 'goal' | 'request';
		goalNumber: number;
		slot: number;
		account?: Account;
		establishesLogin: boolean;
	}
): Promise<{ report: FlowReport; trajectory?: Trajectory; flowId?: string }> {
	const report: FlowReport = {
		goal: flow.goal,
		category: flow.category,
		startUrl: flow.startUrl,
		steps: 0,
		seconds: 0
	};
	const startedAt = performance.now();
	const flowId = newId();
	const run = (startUrl: string) =>
		runTrajectory(browser, ctx, screenIndex, {
			flow,
			startUrl,
			flowId,
			goalNumber: options.goalNumber,
			slot: options.slot,
			account: options.account,
			startSignedIn: flow.signedIn,
			establishesLogin: options.establishesLogin
		});
	let trajectory: Trajectory | undefined;
	let savedFlowId: string | undefined;
	try {
		try {
			trajectory = await run(flow.startUrl);
		} catch (error) {
			if (!(error instanceof StartPageUnavailable) || flow.startUrl === ctx.site.url) throw error;
			console.warn(`    #${options.goalNumber} ${error.message}, starting at the landing page`);
			trajectory = await run(ctx.site.url);
		}
		report.outcome = trajectory.outcome;
		report.reason = trajectory.reason;
		report.steps = trajectory.steps.length - 1;
		console.log(
			`    #${options.goalNumber} -> ${trajectory.outcome}, ${report.steps} steps: ${trajectory.reason}`
		);
		if (trajectory.video === undefined) {
			report.notSaved = 'it never left the start page, and the verdict was not worth a flow';
		} else {
			await saveFlow(ctx, flowId, flow, options.source, trajectory);
			savedFlowId = flowId;
		}
	} catch (error) {
		if (error instanceof CrawlCancelled) throw error;
		report.outcome = 'error';
		report.reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
		report.notSaved = 'the run failed';
		console.warn(`    #${options.goalNumber} failed: ${report.reason}`);
	}
	report.seconds = (performance.now() - startedAt) / 1000;
	return { report, trajectory, flowId: savedFlowId };
}

/** Stores a trajectory as a flow, and its recording as the flow's video. */
async function saveFlow(
	ctx: CrawlContext,
	flowId: string,
	flow: PlannedFlow,
	source: 'goal' | 'request',
	trajectory: Trajectory
): Promise<void> {
	await ctx.db
		.query('CREATE ONLY $id CONTENT $content', {
			id: new RecordId('flow', flowId),
			content: {
				site: ctx.job.site,
				crawl: ctx.job.id,
				viewport: ctx.job.viewport,
				source,
				title: flow.goal,
				category: flow.category,
				goal: flow.goal,
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
	await setFlowVideo(ctx.db, flowId, trajectory.video!);
}

// --- the demo account ---------------------------------------------------------------------------

/** What `establishLogin` leaves behind for the rest of the run. */
interface LoginResult {
	/** The account to use for flows, or undefined when the site has none that works. */
	account?: Account;
	/** The landing page as the account sees it, which the model plans the flows behind the login from. */
	landing?: Landing;
	report?: FlowReport;
}

/**
 * Opens an address with the saved login and captures what it shows as the account's landing page.
 * Undefined when the login no longer works there.
 */
async function visitWithSavedLogin(
	browser: Browser,
	ctx: CrawlContext,
	screenIndex: ScreenIndex,
	account: Account,
	url: string
): Promise<Landing | undefined> {
	const { context } = await openContext(browser, ctx.job.viewport, {
		storageState: account.storage_state
	});
	try {
		const page = await context.newPage();
		await loadPage(page, url, { waitForBanner: true });
		if (!(await looksSignedIn(page))) return undefined;
		return await captureLanding(ctx, page, screenIndex, true);
	} finally {
		await closeBrowser(context);
	}
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
	existing: Account | undefined
): Promise<LoginResult> {
	if (!mailIsConfigured()) {
		console.warn(`[${ctx.siteId}] REFS_MAIL_ADDRESS is not set, so no account is created`);
		return {};
	}

	if (existing?.status === 'active' && existing.storage_state !== undefined) {
		const landing = await visitWithSavedLogin(browser, ctx, screenIndex, existing, ctx.site.url);
		if (landing !== undefined) return { account: existing, landing };
		console.log(`[${ctx.siteId}] the saved login has expired, logging in again`);
	}

	// Without a working account the site gets a new one. An account whose login merely expired
	// keeps its address and password, which the model types into the login form.
	const loggingInAgain = existing?.status === 'active';
	const account = loggingInAgain ? existing : await startAccount(ctx.db, ctx.siteId, existing);
	const goal: PlannedFlow = {
		goal: loggingInAgain
			? 'Log in to the existing account and stop once you are signed in'
			: 'Sign up for an account and stop once you are signed in',
		category: loggingInAgain ? 'logging_in' : 'signing_up',
		area: 'Account',
		startUrl: ctx.site.url,
		success: 'The page shows the product as a signed-in user sees it.',
		signedIn: false
	};
	await ctx.setActivity(loggingInAgain ? 'Logging in to the demo account' : 'Signing up');
	const { report, trajectory } = await attemptFlow(browser, ctx, screenIndex, goal, {
		source: 'goal',
		goalNumber: 0,
		slot: 0,
		account,
		establishesLogin: true
	});
	if (report.outcome === 'error') {
		// The run itself broke (a crashed page, the model server), which says nothing about the site.
		return { report };
	}
	if (trajectory?.storageState === undefined) {
		await failAccount(ctx.db, ctx.siteId, report.reason ?? 'the sign-up did not finish');
		return { report };
	}
	await saveLogin(ctx.db, ctx.siteId, trajectory.storageState);
	const activeAccount = (await loadAccount(ctx.db, ctx.siteId))!;
	// What the saved login shows at the site's address is a page behind the login, unless the site
	// shows its marketing page to signed-in users as well. Then the last page the sign-up reached
	// is the next best thing.
	let landing = await visitWithSavedLogin(browser, ctx, screenIndex, activeAccount, ctx.site.url);
	const lastSignedInScreen = trajectory.signedInScreens.at(-1);
	if (landing === undefined && lastSignedInScreen !== undefined) {
		landing = await visitWithSavedLogin(
			browser,
			ctx,
			screenIndex,
			activeAccount,
			screenIndex.get(lastSignedInScreen).url
		);
	}
	return { account: activeAccount, landing, report };
}

/**
 * Addresses and headings of the first-run setup a product shows a new account, like Linear's
 * /neoworksdev/welcome with "Set up your profile". Matched loosely: a page that is not one costs a
 * short flow that ends at once, and one that is missed leaves the plan with only its setup steps.
 */
const ONBOARDING_PATH = /\/(welcome|onboarding|setup|set-up|get-started|getting-started)(\/|$|\?)/i;
const ONBOARDING_HEADING =
	/^(welcome to|set up your|let'?s get (you )?started|tell us about|personali[sz]e|create your (first )?(workspace|team|project|organi[sz]ation))/i;

function isOnboarding(page: LandingPage): boolean {
	return (
		ONBOARDING_PATH.test(new URL(page.url).pathname) ||
		page.headings.some((heading) => ONBOARDING_HEADING.test(heading))
	);
}

/**
 * Goes through the onboarding a new account landed in, as a flow of its own, because it is worth
 * recording and because the flows behind the login should be planned from the product it leads
 * to, not from its first step. The login is saved again afterwards, in case finishing the setup
 * changed it.
 */
async function finishOnboarding(
	browser: Browser,
	ctx: CrawlContext,
	screenIndex: ScreenIndex,
	account: Account,
	landing: Landing
): Promise<LoginResult> {
	await ctx.setActivity('Going through the onboarding');
	const goal: PlannedFlow = {
		goal:
			'Go through the onboarding of the new account step by step until the product itself is ' +
			'shown. Skip inviting people and connecting other services.',
		category: 'onboarding',
		area: 'Account',
		startUrl: landing.page.url,
		success: 'The product itself is shown, past the welcome and setup steps.',
		signedIn: true
	};
	const { report, trajectory } = await attemptFlow(browser, ctx, screenIndex, goal, {
		source: 'goal',
		goalNumber: 0,
		slot: 0,
		account,
		// So the run ends by reading the login, which is saved below when it got through.
		establishesLogin: true
	});
	if (trajectory?.storageState !== undefined) {
		await saveLogin(ctx.db, ctx.siteId, trajectory.storageState);
	}
	const activeAccount = (await loadAccount(ctx.db, ctx.siteId))!;
	// An onboarding that broke off leaves the account where it was; planning from that is still
	// better than not planning the signed-in flows at all.
	const after = await visitWithSavedLogin(browser, ctx, screenIndex, activeAccount, ctx.site.url);
	return { account: activeAccount, landing: after ?? landing, report };
}

// --- running a crawl's flows -------------------------------------------------------------------

/**
 * Establishes the demo account, plans the flows from the landing page (and from the signed-in
 * landing page, when there is an account) and tries them, at most `maxFlows` of them. That is a
 * bound on the run, not a target: the model decides how many flows the site deserves.
 */
export async function exploreSite(options: {
	ctx: CrawlContext;
	browser: Browser;
	screenIndex: ScreenIndex;
	landing: Landing;
	maxFlows: number;
	concurrency?: number;
}): Promise<ExplorationSummary> {
	const { ctx, browser, screenIndex, landing, maxFlows } = options;
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const startedAt = performance.now();
	const label = `${ctx.siteId} ${ctx.job.viewport}`;

	const login = await establishLogin(
		browser,
		ctx,
		screenIndex,
		await loadAccount(ctx.db, ctx.siteId)
	);
	const onboarding =
		login.account !== undefined && login.landing !== undefined && isOnboarding(login.landing.page)
			? await finishOnboarding(browser, ctx, screenIndex, login.account, login.landing)
			: undefined;
	const signedInLanding = onboarding === undefined ? login.landing : onboarding.landing;

	await ctx.setActivity('Planning what to capture');
	const planRequest = {
		siteName: ctx.site.name,
		siteUrl: ctx.site.url,
		host: ctx.site.host,
		viewport: ctx.job.viewport,
		hasAccount: login.account !== undefined
	};
	const visitorFlows = await planFlows({
		...planRequest,
		image: landing.image,
		page: landing.page,
		signedIn: false
	});
	const signedInFlows =
		signedInLanding === undefined
			? []
			: await planFlows({
					...planRequest,
					image: signedInLanding.image,
					page: signedInLanding.page,
					signedIn: true
				});
	// Alternating keeps a run that hits its bound from covering only one of the two.
	const flows = interleave([visitorFlows, signedInFlows]);
	console.log(
		`[${label}] ${flows.length} flows planned (${visitorFlows.length} for a visitor, ${signedInFlows.length} signed in)`
	);
	for (const flow of flows) {
		console.log(
			`  [${flow.category}] ${flow.signedIn ? 'signed in, ' : ''}${flow.area}: ${flow.goal}`
		);
	}

	// Workers take the next flow off the shared queue.
	const queue = [...flows];
	const reports: FlowReport[] = [];
	let started = 0;
	async function work(slot: number): Promise<void> {
		for (;;) {
			const flow = queue.shift();
			if (flow === undefined || started >= maxFlows) return;
			started++;
			const goalNumber = started;
			console.log(
				`[${label}] #${goalNumber}/${Math.min(maxFlows, flows.length)} ${flow.goal} [${flow.category}] from ${flow.startUrl}`
			);
			const { report } = await attemptFlow(browser, ctx, screenIndex, flow, {
				source: 'goal',
				goalNumber,
				slot,
				account: login.account,
				establishesLogin: false
			});
			reports.push(report);
		}
	}
	await ctx.setActivity('Exploring toward goals');
	await Promise.all(Array.from({ length: concurrency }, (_worker, slot) => work(slot)));

	const summary = {
		plannedFlows: flows.length,
		login: login.report,
		onboarding: onboarding?.report,
		flows: reports,
		seconds: (performance.now() - startedAt) / 1000
	};
	const reached = reports.filter((report) => report.outcome === 'done').length;
	console.log(
		`[${label}] ${reports.length} of ${flows.length} planned flows tried, ${reached} reached their goal, in ${Math.round(summary.seconds)} s`
	);
	return summary;
}
