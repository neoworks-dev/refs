// Records a video of every flow of a crawl by replaying it in a fresh browser: load the first
// screen, then click through the flow the way a visitor would, at the places the crawler recorded.
// Flows are assembled from screens the crawler reached in separate page loads, so a recording of the
// crawl itself would show no journey. `bun crawler/videos.ts [site-slug]` records the flows that
// have no video yet, for one site or for every site; `--redo` records them again.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { errors, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Surreal } from 'surrealdb';
import { localMedia, type MediaStore } from '#lib/server/media.ts';
import { configFromEnv, connect, plain, RecordId } from '#lib/server/surreal.ts';
import { sourceCrawls } from '#lib/server/library.ts';
import type { Action, Flow, FlowVideo, Rect, Screen } from '#lib/types.ts';
import { acceptCookieBanner, closeBrowser, loadPage, openBrowser } from './capture.ts';
import { setFlowVideo, startRecording, type FlowRecording, type Point } from './recording.ts';
import { normalizeUrl, urlKey } from './rules.ts';

type ReplayScreen = Pick<Screen, 'id' | 'kind' | 'url'>;
type ReplayAction = Pick<Action, 'id' | 'in' | 'out' | 'kind' | 'label' | 'rect'>;
type ReplayFlow = Pick<Flow, 'id' | 'site' | 'viewport' | 'title' | 'steps'>;

export interface ReplayResult {
	flow: ReplayFlow;
	video: FlowVideo;
}

/** How long a viewer needs to take in a page before the visitor moves on. */
const STEP_HOLD_MS = 1800;
const NAVIGATION_TIMEOUT_MS = 20_000;
/** Many sites never reach network idle (polling, websockets), so waiting for it is capped. */
const NETWORK_IDLE_CAP_MS = 5000;
/** A click that changes nothing on the page within this long did not do what the crawler saw. */
const STATE_CHANGE_TIMEOUT_MS = 3000;
/** A panel counts as open once the page has been quiet this long, so its animation is over. */
const STATE_QUIET_MS = 400;
/** Pages that never go quiet (carousels, tickers) still count as changed after this long. */
const STATE_MAX_SETTLE_MS = 1500;
/** The browser takes about this long to scroll a page smoothly; this bounds the wait if it never says. */
const SCROLL_TIMEOUT_MS = 2000;
/** A control that has to be scrolled to ends up this far down the viewport, so it has room around it. */
const SCROLL_TARGET_FRACTION = 0.4;

/** What stops a replay: the flow can't be carried out any further. Its message is stored. */
class ReplayFailure extends Error {}

// --- recording a crawl's flows -------------------------------------------------------------------

/**
 * Replays the flows of one crawl and stores a video for each. Flows that already have one are
 * left alone unless `redo` is set, and goal-directed flows are skipped because exploration records
 * those live. A replay that breaks halfway keeps its partial video; a flow that can't be replayed
 * at all is logged and stays without one.
 */
export async function recordFlowVideos(
	db: Surreal,
	crawlId: string,
	media: MediaStore,
	options: { redo?: boolean } = {}
): Promise<ReplayResult[]> {
	const crawl = new RecordId('crawl', crawlId);
	const [flowRows, screenRows, actionRows] = await db
		.query(
			`SELECT id, site, viewport, title, steps FROM flow
			   WHERE crawl = $crawl AND source = 'structure' ${options.redo ? '' : 'AND video IS NONE'};
			 SELECT id, kind, url FROM screen WHERE crawl = $crawl;
			 SELECT id, in, out, kind, label, rect FROM action WHERE crawl = $crawl`,
			{ crawl }
		)
		.collect<[unknown[], unknown[], unknown[]]>();
	const flows = plain<ReplayFlow[]>(flowRows);
	const screens = new Map(plain<ReplayScreen[]>(screenRows).map((screen) => [screen.id, screen]));
	const actions = new Map(plain<ReplayAction[]>(actionRows).map((action) => [action.id, action]));

	const results: ReplayResult[] = [];
	if (flows.length === 0) return results;

	// One browser for the crawl's flows, with a fresh page for each: a second browser in the process
	// is what Bun stalls on (see `recordFlowVideosInNewProcess`).
	const { browser, context } = await openBrowser(flows[0].viewport);
	try {
		for (const flow of flows) {
			try {
				const video = await replayFlow(context, flow, screens, actions, media);
				await setFlowVideo(db, flow.id, video);
				results.push({ flow, video });
			} catch (error) {
				// A site that times out or a page that crashes shouldn't stop the flows after it.
				console.warn(
					`  no video for "${flow.title}": ${error instanceof Error ? error.message : error}`
				);
			}
		}
	} finally {
		await closeBrowser(browser);
	}
	return results;
}

/** Replays the flow in a new page of the context into a recording and stores the file. */
async function replayFlow(
	context: BrowserContext,
	flow: ReplayFlow,
	screens: Map<string, ReplayScreen>,
	actions: Map<string, ReplayAction>,
	media: MediaStore
): Promise<FlowVideo> {
	const firstScreen = screens.get(flow.steps[0].screen);
	if (firstScreen === undefined || firstScreen.kind !== 'page') {
		throw new Error('the flow does not start at a page');
	}

	const page = await context.newPage();
	// Pop-ups and native dialogs are never wanted, as in the crawl itself.
	const closePopup = (popup: Page) => {
		if (popup !== page) void popup.close();
	};
	context.on('page', closePopup);
	page.on('dialog', (dialog) => void dialog.dismiss());
	try {
		// The consent banner is accepted before recording starts, so its click is not part of the
		// video. Later loads carry the consent cookie and show no banner.
		await loadPage(page, firstScreen.url, { waitForBanner: true });
		const recording = await startRecording(page, flow.viewport);

		let failed: string | undefined;
		try {
			await carryOutSteps(page, recording, flow, screens, actions);
		} catch (error) {
			// Timeouts, a control that is gone and a page that moved on are what a replay is
			// expected to hit. The video is kept up to there and says why it stops.
			failed = error instanceof Error ? error.message.split('\n')[0] : String(error);
			console.warn(`  "${flow.title}" stopped: ${failed}`);
		}
		return await recording.finish({ media, site: flow.site, flowId: flow.id, failed });
	} finally {
		context.off('page', closePopup);
		await page.close();
	}
}

// --- carrying out the steps ----------------------------------------------------------------------

/**
 * Loads the first screen and then each following step's action, marking the second every step is
 * reached. Throws a ReplayFailure, or an error from the browser, at the first step that can't be
 * carried out.
 */
async function carryOutSteps(
	page: Page,
	recording: FlowRecording,
	flow: ReplayFlow,
	screens: Map<string, ReplayScreen>,
	actions: Map<string, ReplayAction>
): Promise<void> {
	let current = screens.get(flow.steps[0].screen)!;
	// The page we got to `current` from, so that going back to it can use the back button.
	let cameFrom: ReplayScreen | undefined;

	await page.goto(current.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
	await settle(page);
	await recording.restorePointer();
	recording.markStep();

	for (const [index, step] of flow.steps.entries()) {
		if (index === 0) continue;
		await page.waitForTimeout(STEP_HOLD_MS);

		const action = step.action === undefined ? undefined : actions.get(step.action);
		const target = screens.get(step.screen);
		const stepName = `step ${index + 1}`;
		if (action === undefined || target === undefined) {
			throw new ReplayFailure(`${stepName} has no recorded action to repeat`);
		}
		const source = screens.get(action.in);
		if (source === undefined) throw new ReplayFailure(`${stepName} starts from an unknown screen`);

		try {
			// Several steps of a flow can come from one screen (a list and the pages it links to), so a
			// step often starts somewhere other than where the previous one ended. A link to the target
			// on the current page is the natural way on; only without one does the visitor return to
			// where the crawler found the link.
			let point: Point | undefined;
			if (source.id !== current.id) {
				if (target.kind === 'page') point = await findControl(page, action, target, false);
				if (point === undefined) {
					if (source.kind !== 'page') {
						throw new ReplayFailure(
							`${stepName} starts from a state that is not the previous step`
						);
					}
					if (cameFrom?.id === source.id && current.kind === 'page') {
						await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
					} else {
						await page.goto(source.url, {
							waitUntil: 'domcontentloaded',
							timeout: NAVIGATION_TIMEOUT_MS
						});
					}
					await settle(page);
					await recording.restorePointer();
					current = source;
				}
			}
			if (point === undefined) point = await findControl(page, action, target, true);
			await carryOutAction(page, recording, action, target, point, stepName);
		} catch (error) {
			if (error instanceof ReplayFailure) throw error;
			const reason = error instanceof errors.TimeoutError ? 'timed out' : String(error);
			throw new ReplayFailure(`${stepName} (${describe(action)}) ${reason.split('\n')[0]}`);
		}
		cameFrom = target.kind === 'page' ? current : undefined;
		current = target;
		await recording.restorePointer();
		recording.markStep();
	}
	await page.waitForTimeout(STEP_HOLD_MS);
}

function describe(action: ReplayAction): string {
	return action.label.trim() === ''
		? action.kind
		: `${action.kind} "${action.label.trim().slice(0, 40)}"`;
}

/**
 * Carries out one action at the control found for it: clicks it and waits for what the crawler saw happen, which is a navigation to the next page or a change of
 * the page itself. A link that can't be found is the one thing worth going to the URL for, and
 * that is said in the log.
 */
async function carryOutAction(
	page: Page,
	recording: FlowRecording,
	action: ReplayAction,
	target: ReplayScreen,
	point: Point | undefined,
	stepName: string
): Promise<void> {
	if (point === undefined) {
		if (action.kind !== 'navigate') {
			throw new ReplayFailure(`${stepName} could not find ${describe(action)} on the page`);
		}
		console.warn(`    ${stepName}: ${describe(action)} not found, went to ${target.url} directly`);
		await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
		await settle(page);
		return;
	}

	if (target.kind === 'page') {
		// A link that opens a new tab would leave the recorded page on the old one, and the
		// crawl closes pop-ups. Opening it in place is the closest a recording can get.
		await page.evaluate(
			([x, y]) => document.elementFromPoint(x, y)?.closest('a')?.setAttribute('target', '_self'),
			[point.x, point.y] as const
		);
		await recording.click(point);
		await page.waitForURL((url) => sameLocation(url.href, target.url), {
			waitUntil: 'domcontentloaded',
			timeout: NAVIGATION_TIMEOUT_MS
		});
		await settle(page);
		return;
	}

	// A state has no URL, so what the click did is seen in the page changing. The mutation times
	// are collected from before the pointer starts moving, because a click is only awaited after it.
	const mutationLog = '__refsMutationTimes';
	await page.evaluate((logKey) => {
		const times: number[] = [];
		(window as unknown as Record<string, number[]>)[logKey] = times;
		new MutationObserver(() => times.push(Date.now())).observe(document, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true
		});
	}, mutationLog);
	await recording.click(point);
	const clickedAt = Date.now();
	await page.waitForFunction(
		([logKey, since, quietMs, maxSettleMs]) => {
			const times = (window as unknown as Record<string, number[]>)[logKey as string];
			const afterClick = times.filter((time) => time >= (since as number) - 50);
			if (afterClick.length === 0) return false;
			const now = Date.now();
			return (
				now - afterClick[afterClick.length - 1] >= (quietMs as number) ||
				now - afterClick[0] >= (maxSettleMs as number)
			);
		},
		[mutationLog, clickedAt, STATE_QUIET_MS, STATE_MAX_SETTLE_MS] as const,
		{ timeout: STATE_CHANGE_TIMEOUT_MS + STATE_MAX_SETTLE_MS }
	);
}

/**
 * Where to click for an action, as a point in the viewport. First the rect the crawler recorded
 * (after checking that a control with the same label is really there), which is only meaningful
 * on the screen the action was recorded on. Then a control found by its role and name, which
 * survives layout changes, and for a navigation any link that points at the target page.
 */
async function findControl(
	page: Page,
	action: ReplayAction,
	target: ReplayScreen,
	useRect: boolean
): Promise<Point | undefined> {
	if (useRect && action.rect !== undefined) {
		const point = await scrollToRect(page, action.rect);
		const control = await page.evaluate(([x, y]) => window.pageInspector!.probeAt(x, y), [
			point.x,
			point.y
		] as const);
		if (control !== undefined && controlMatches(control, action, target)) return point;
	}

	const candidates: Locator[] = [];
	const name = action.label.trim();
	if (name !== '') {
		candidates.push(
			page
				.getByRole('link', { name })
				.or(page.getByRole('button', { name }))
				.or(page.getByRole('tab', { name }))
				.or(page.getByRole('menuitem', { name }))
		);
	}
	if (action.kind === 'navigate') {
		const { pathname, search } = new URL(target.url);
		const path = JSON.stringify(pathname + search);
		candidates.push(page.locator(`a[href$=${path}], a[href$=${JSON.stringify(pathname + '/')}]`));
	}
	for (const candidate of candidates) {
		const control = candidate.filter({ visible: true }).first();
		if ((await control.count()) === 0) continue;
		await control.scrollIntoViewIfNeeded();
		const box = await control.boundingBox();
		if (box !== null) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	}
	return undefined;
}

/**
 * Scrolls smoothly until the rect (page coordinates) is in view, and returns its centre in
 * viewport coordinates. Smooth, because a jump would look like a cut in the video.
 */
async function scrollToRect(page: Page, rect: Rect): Promise<Point> {
	const viewportHeight = page.viewportSize()!.height;
	const scroll = () => page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
	const before = await scroll();
	const isInView = rect.y >= before.y && rect.y + rect.h <= before.y + viewportHeight;
	if (!isInView) {
		const top = rect.y + rect.h / 2 - viewportHeight * SCROLL_TARGET_FRACTION;
		await page.evaluate(
			async ([wantedTop, timeoutMs]) => {
				const target = Math.min(
					Math.max(wantedTop, 0),
					document.documentElement.scrollHeight - window.innerHeight
				);
				if (Math.abs(window.scrollY - target) < 1) return;
				// `scrollend` is the real signal; the timeout covers pages that scroll in some
				// element other than the window, where it never fires.
				await new Promise<void>((resolve) => {
					window.addEventListener('scrollend', () => resolve(), { once: true });
					setTimeout(resolve, timeoutMs);
					window.scrollTo({ top: target, behavior: 'smooth' });
				});
			},
			[top, SCROLL_TIMEOUT_MS] as const
		);
	}
	const after = await scroll();
	return { x: rect.x + rect.w / 2 - after.x, y: rect.y + rect.h / 2 - after.y };
}

// --- matching what is on the page with what was recorded ---------------------------------------

function collapse(text: string): string {
	return text
		.replace(/\s+/g, ' ')
		.replace(/[….]+$/, '')
		.trim()
		.toLowerCase();
}

/**
 * Whether the control found at a recorded rect is the one the action clicked. Labels are compared
 * loosely, because the crawler stored link text and a page's accessible name differs in small
 * ways. Some links have no text (a logo, an image card), and then the link target has to be the
 * screen the action led to.
 */
export function controlMatches(
	control: { name: string; href?: string },
	action: Pick<ReplayAction, 'kind' | 'label'>,
	target: Pick<ReplayScreen, 'url'>
): boolean {
	const expected = collapse(action.label);
	if (expected === '') {
		if (action.kind === 'click') return true;
		return control.href !== undefined && sameLocation(control.href, target.url);
	}
	const found = collapse(control.name);
	return found !== '' && (found.includes(expected) || expected.includes(found));
}

/** Whether two URLs are the same page, ignoring tracking parameters, fragments and trailing slashes. */
export function sameLocation(first: string, second: string): boolean {
	const normalizedFirst = normalizeUrl(first);
	const normalizedSecond = normalizeUrl(second);
	return (
		normalizedFirst !== undefined &&
		normalizedSecond !== undefined &&
		urlKey(normalizedFirst) === urlKey(normalizedSecond)
	);
}

/** Brings a freshly loaded page to a state worth showing: network quiet, banner gone, fonts in. */
async function settle(page: Page): Promise<void> {
	try {
		await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_CAP_MS });
	} catch (error) {
		if (!(error instanceof errors.TimeoutError)) throw error;
	}
	await acceptCookieBanner(page, { waitForBanner: false });
	await page.evaluate(() => document.fonts.ready);
}

// --- running --------------------------------------------------------------------------------------

/**
 * Bun stalls on the second Chrome it starts in one process: Playwright's pipe to the browser stops
 * delivering, and the replay waits forever in whatever call it was in (found with a crawl's own
 * browser closed before the replay, and with two crawls replayed in one process; the first browser
 * of a process was always fine). So the replays of a crawl run in a process of their own.
 */
const CRAWL_REPLAY_TIMEOUT_MS = 20 * 60_000;

/**
 * Runs `recordFlowVideos` for one crawl in a fresh process, with its output on ours. Flows that were
 * recorded before a failure or the timeout keep their videos.
 */
export async function recordFlowVideosInNewProcess(
	crawlId: string,
	options: { redo?: boolean } = {}
): Promise<void> {
	const child = spawn(
		process.execPath,
		[fileURLToPath(import.meta.url), '--crawl', crawlId, ...(options.redo ? ['--redo'] : [])],
		{ stdio: 'inherit', signal: AbortSignal.timeout(CRAWL_REPLAY_TIMEOUT_MS) }
	);
	const [exitCode] = await once(child, 'exit');
	if (exitCode !== 0) throw new Error(`video recording exited with code ${exitCode}`);
}

if (import.meta.main) {
	const arguments_ = process.argv.slice(2);
	const redo = arguments_.includes('--redo');
	const crawlFlag = arguments_.indexOf('--crawl');
	const db = await connect(configFromEnv(process.env));

	if (crawlFlag !== -1) {
		// The child process of `recordFlowVideosInNewProcess`: one crawl, one browser.
		const media = localMedia(process.env.MEDIA_DIR ?? 'data/media');
		for (const { flow, video } of await recordFlowVideos(db, arguments_[crawlFlag + 1], media, {
			redo
		})) {
			const outcome = video.failed === undefined ? 'replayed' : `stopped: ${video.failed}`;
			console.log(
				`  ${flow.title}: ${video.steps.length}/${flow.steps.length} steps, ${video.duration.toFixed(1)} s, ${outcome}`
			);
		}
	} else {
		const site = arguments_.find((argument) => !argument.startsWith('--'));
		for (const crawl of await sourceCrawls(db, site)) {
			console.log(`\n${crawl.site} ${crawl.viewport} (crawl ${crawl.id})`);
			await recordFlowVideosInNewProcess(crawl.id, { redo });
		}
	}
	await db.close();
}
