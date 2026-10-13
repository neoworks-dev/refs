// One goal tried in a browser: screenshot, ask the model for the next action, carry it out, capture
// the screen it leads to, until the goal is reached or the run ends some other way. Used by
// exploration (explore.ts) for every goal, and for signing up and logging in to the demo account.
import type { Browser, Page } from 'playwright';
import { RecordId } from '#lib/server/surreal.ts';
import type { Account } from '#lib/types.ts';
import type { FlowOutcome, FlowVideo, Rect } from '#lib/types.ts';
import { identityOf, looksSignedIn, pageAsksForVerification } from './accounts.ts';
import {
	carryOut,
	decideNextAction,
	describeAction,
	refusalReason,
	resolveTarget,
	settle,
	type AgentAction,
	type AgentIdentity,
	type HistoryEntry
} from './agent.ts';
import {
	acceptCookieBanner,
	captureScreen,
	type CaptureRequest,
	closeBrowser,
	computeDomSig,
	dHash,
	hammingDistance,
	loadPage,
	openContext,
	stabilizeLoadedPage,
	viewportScreenshot
} from './capture.ts';
import { SAME_STATE_HASH_DISTANCE, STATE_HASH_DISTANCE, type CrawlContext } from './crawl.ts';
import type { PlannedGoal, MappedPage } from './goals.ts';
import { endLiveGoal, reportLiveGoal } from './live.ts';
import { waitForVerificationMail } from './mail.ts';
import type { ProbedControl } from './page.ts';
import { startRecording } from './recording.ts';
import { displayPath, isSameSite, normalizeUrl, urlKey } from './rules.ts';

export interface KnownScreen {
	id: string;
	url: string;
	imageHash: string;
	domSig: string;
	depth: number;
	kind: 'page' | 'state';
	/** Captured while logged in to the demo account. */
	signedIn: boolean;
}

/**
 * The screens of the crawl, and how to tell which of them the browser is showing. A trajectory
 * that reaches a stored screen again reuses it; only a screen nobody has seen is captured. A screen
 * is only reused by a browser in the same login state, so a visitor's flow never shows a
 * screen that was captured logged in.
 */
export class ScreenIndex {
	constructor(private readonly screens: KnownScreen[]) {}

	get(id: string): KnownScreen {
		return this.screens.find((screen) => screen.id === id)!;
	}

	/**
	 * The screen the page shows now, after an action that started from `previous`, or on arrival
	 * when there is no previous screen. Captured when it is new. The look is judged at the top of
	 * the page, as when the crawler captured pages, so scrolling alone never makes a screen.
	 */
	async observe(
		ctx: CrawlContext,
		page: Page,
		previous: KnownScreen | undefined,
		textBefore: string,
		signedIn: boolean
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
		if (previous === undefined || urlKey(previous.url) !== urlKey(url)) {
			// A page is recognised by its address and a looser look: a hero animation or a banner
			// that was not there when the crawler came by must not make it a new page.
			screen = this.screens.find(
				(known) =>
					known.kind === 'page' &&
					known.signedIn === signedIn &&
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
							known.signedIn === signedIn &&
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
					newPanels,
					signedIn
				});
			}
		}
		if (screen === undefined) {
			screen = await this.capture(ctx, page, {
				kind: 'page',
				url,
				depth: previous === undefined ? 0 : previous.depth + 1,
				domSig,
				signedIn
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
		request: Pick<CaptureRequest, 'kind' | 'url' | 'depth' | 'domSig' | 'newPanels' | 'signedIn'>
	): Promise<KnownScreen> {
		const captured = await captureScreen({ page, ctx, ...request });
		const screen: KnownScreen = {
			id: captured.id,
			url: request.url,
			imageHash: captured.imageHash,
			domSig: request.domSig,
			depth: request.depth,
			kind: request.kind,
			signedIn: request.signedIn === true
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
/**
 * How long a verification email is waited for. Most arrive within seconds, and the ones that take
 * minutes (greylisting, a slow queue) are rare enough that a site which needs longer is not worth
 * a run's time.
 */
const VERIFICATION_MAIL_DEADLINE_MS = 4 * 60_000;

export interface TrajectoryStep {
	screen: string;
	/** The action that led here; missing on the first step. */
	action?: RecordId;
	thought?: string;
}

export interface Trajectory {
	steps: TrajectoryStep[];
	outcome: FlowOutcome;
	reason: string;
	/** The recording of the run, or undefined when the run is not worth keeping. */
	video?: FlowVideo;
	/** The browser was logged in to the demo account for at least one step. */
	signedIn: boolean;
	/** The screens the run reached while logged in. */
	signedInScreens: string[];
	/**
	 * The browser's login (Playwright's storage state as JSON), only for a run that signed up or
	 * logged in and got in. It is read before the browser closes.
	 */
	storageState?: string;
}

export interface TrajectoryRequest {
	goal: PlannedGoal;
	startPage: MappedPage;
	flowId: string;
	goalNumber: number;
	/** The worker running this goal, which tells goals running at the same time apart in the live panel. */
	slot: number;
	/**
	 * The site's demo account, when it has one that may be used. Its email and password go to the
	 * model, and submitting a form is allowed, which a visitor's run never does.
	 */
	account?: Account;
	/** Start the browser with the account's saved login. */
	startSignedIn: boolean;
	/**
	 * The run signs up or logs in. It reads the verification email the site sends, and ends by
	 * saving the login if it got in.
	 */
	establishesLogin: boolean;
}

/**
 * A run that never left its start page is only kept when it ends with one of these verdicts. "Done"
 * is not among them: the goal was already satisfied by the page itself, which the library has.
 */
const VERDICT_OUTCOMES: FlowOutcome[] = ['gave_up', 'blocked'];

/** Runs one goal in a fresh browser context, from its start page until it ends one way or another. */
export async function runTrajectory(
	browser: Browser,
	ctx: CrawlContext,
	screenIndex: ScreenIndex,
	request: TrajectoryRequest
): Promise<Trajectory> {
	const { goal, startPage, account } = request;
	let identity: AgentIdentity | undefined = account && identityOf(account);
	const { context } = await openContext(browser, ctx.job.viewport, {
		storageState: request.startSignedIn ? account?.storage_state : undefined
	});
	try {
		const page = await context.newPage();
		// Pop-ups (target=_blank links, OAuth windows) are never wanted; native dialogs would block the page.
		context.on('page', (popup) => {
			if (popup !== page) void popup.close();
		});
		page.on('dialog', (dialog) => void dialog.dismiss());
		// Submitting a form (signing up, subscribing, paying) is a POST navigation. Without a demo
		// account, whatever the model presses never goes through. With one, signing up and logging in
		// need it, and the model cannot type payment details anyway. Routes added last run first;
		// `fallback` hands on to the blocking of analytics hosts that `openBrowser` set up.
		await context.route('**/*', (route) => {
			const routed = route.request();
			if (
				account === undefined &&
				routed.method() === 'POST' &&
				routed.resourceType() === 'document'
			)
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

		// Whether the browser is logged in. A saved login that expired shows the login again, so it is
		// checked. Otherwise the run becomes logged in when the model types the password and the
		// page then stops looking like a login or sign-up page.
		let signedIn = request.startSignedIn && (await looksSignedIn(page));
		let typedPassword = false;
		const signedInScreens: string[] = signedIn ? [current.id] : [];
		/** Shows the goal and the page as they are now in the live panel. */
		const showLive = (step: number, thought?: string, action?: string) =>
			reportLiveGoal(ctx.db, page, {
				crawl: ctx.job.id,
				site: ctx.job.site,
				viewport: ctx.job.viewport,
				slot: request.slot,
				goal: goal.goal,
				step,
				thought,
				action,
				signedIn
			});
		// The panel shows the goal at once, before the model has decided anything.
		await showLive(0);
		// Set when the model first types the account's email: mail to the account that arrives from
		// then on is the site's reply to the sign-up or login.
		let mailSince: Date | undefined;
		let mailChecked = false;
		let forcedAction: AgentAction | undefined;

		// The recording is finished here, while the browser is still open.
		const ended = async (outcome: FlowOutcome, reason: string): Promise<Trajectory> => {
			let finalOutcome = outcome;
			let finalReason = reason;
			let storageState: string | undefined;
			if (request.establishesLogin && outcome === 'done') {
				if (await looksSignedIn(page)) {
					signedIn = true;
					storageState = JSON.stringify(await context.storageState());
				} else {
					finalOutcome = 'stuck';
					finalReason = `the model reported "${reason}", but the page still shows a login or sign-up form`;
				}
			}
			const isKept = steps.length > 1 || VERDICT_OUTCOMES.includes(finalOutcome);
			const video = isKept
				? await recording.finish({ media: ctx.media, site: ctx.siteId, flowId: request.flowId })
				: undefined;
			return {
				steps,
				outcome: finalOutcome,
				reason: finalReason,
				video,
				signedIn: signedIn || signedInScreens.length > 0,
				signedInScreens,
				storageState
			};
		};

		for (let stepNumber = 1; stepNumber <= MAX_STEPS_PER_GOAL; stepNumber++) {
			await ctx.throwIfStopped();

			// A site that asks to confirm an email has sent one to the account's plus address by now.
			if (
				request.establishesLogin &&
				mailSince !== undefined &&
				!mailChecked &&
				pageAsksForVerification(await page.locator('body').innerText())
			) {
				mailChecked = true;
				console.log(`    #${request.goalNumber} waiting for the verification email`);
				const mail = await waitForVerificationMail({
					address: account!.email,
					since: mailSince,
					deadlineMs: VERIFICATION_MAIL_DEADLINE_MS,
					signal: ctx.signal
				});
				if (mail === undefined) {
					// A shutdown ends the wait too, and must not be taken for a missing email.
					await ctx.throwIfStopped();
					return await ended('blocked', 'the verification email did not arrive');
				}
				if (mail.link !== undefined) {
					forcedAction = {
						action: 'open_link',
						url: mail.link,
						thought: 'The verification email arrived; opening its link.'
					};
				} else {
					identity = { ...identity!, verificationCode: mail.code };
					history.push({
						action: 'check the inbox',
						result: `the verification email arrived with the code ${mail.code}`
					});
				}
			}

			const startedAt = performance.now();
			const action = forcedAction ?? (await decideNextAction(goal.goal, page, history, identity));
			forcedAction = undefined;
			const decidedIn = ((performance.now() - startedAt) / 1000).toFixed(1);
			console.log(
				`    #${request.goalNumber} step ${stepNumber}: ${describeAction(action, identity)} (${decidedIn} s) ${action.thought}`
			);
			if (action.action === 'done') return await ended('done', action.reason);
			if (action.action === 'give_up') return await ended('gave_up', action.reason);

			const aimsAtPoint = action.action === 'click' || action.action === 'type';
			let control: ProbedControl | undefined;
			if (aimsAtPoint) {
				const point = resolveTarget(action.target);
				control = await page.evaluate(({ x, y }) => window.pageInspector!.probeAt(x, y), point);
				const refusal = refusalReason(control, action.element, ctx.site.host, identity);
				if (refusal !== undefined) return await ended('blocked', refusal);
			}
			if (
				action.action === 'type' &&
				identity !== undefined &&
				action.text === identity.email &&
				mailSince === undefined
			) {
				mailSince = new Date();
			}
			if (action.action === 'type' && action.text === identity?.password) typedPassword = true;

			const urlBefore = page.url();
			const hashBefore = await dHash(await viewportScreenshot(page));
			await page.evaluate(() => window.pageInspector!.snapshotVisible());
			const textBefore = await page.evaluate(() => document.body.innerText);
			const refusal = await carryOut(page, action, recording, identity);
			if (refusal !== undefined) return await ended('blocked', refusal);
			await settle(page);

			const destination = normalizeUrl(page.url());
			if (destination === undefined || !isSameSite(destination, ctx.site.host)) {
				return await ended(
					'blocked',
					`"${describeAction(action, identity)}" led away from the site, to ${page.url()}`
				);
			}

			const urlChanged = urlKey(destination) !== urlKey(urlBefore);
			if (urlChanged) {
				await acceptCookieBanner(page, { waitForBanner: false });
				await stabilizeLoadedPage(page);
				await recording.restorePointer();
			}
			if (!signedIn && typedPassword) signedIn = await looksSignedIn(page);
			const hashAfter = await dHash(await viewportScreenshot(page));
			const viewChanged = hammingDistance(hashBefore, hashAfter) >= SMALL_VIEW_CHANGE;

			// Scrolling and waiting do not change what the page is, unless a redirect moved it.
			const mayHaveChangedScreen = urlChanged || aimsAtPoint;
			const reached = mayHaveChangedScreen
				? await screenIndex.observe(ctx, page, current, textBefore, signedIn)
				: current;
			const movedToAnotherScreen = reached.id !== current.id;
			if (movedToAnotherScreen) {
				const actionId = await recordAction(ctx, current, reached, action, control, identity);
				steps.push({ screen: reached.id, action: actionId, thought: action.thought });
				recording.markStep();
				visits.set(reached.id, (visits.get(reached.id) ?? 0) + 1);
				current = reached;
				if (signedIn && !signedInScreens.includes(reached.id)) signedInScreens.push(reached.id);
			}

			const result = urlChanged
				? `now at ${displayPath(destination)}`
				: movedToAnotherScreen || viewChanged
					? 'the page changed'
					: 'nothing changed';
			history.push({ action: describeAction(action, identity), result });
			await showLive(stepNumber, action.thought, describeAction(action, identity));
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
		await endLiveGoal(ctx.db, ctx.job.id, request.slot);
		await closeBrowser(context);
	}
}

/** Stores the edge from one screen to the next, or finds the one an earlier trajectory made. */
async function recordAction(
	ctx: CrawlContext,
	from: KnownScreen,
	to: KnownScreen,
	action: AgentAction,
	control: ProbedControl | undefined,
	identity: AgentIdentity | undefined
): Promise<RecordId> {
	const label =
		control?.name || ('element' in action ? action.element : describeAction(action, identity));
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
