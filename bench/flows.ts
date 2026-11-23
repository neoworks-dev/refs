// Benchmark of the second step of a crawl: running planned flows in a browser with a decider.
// It takes a plan saved by plan.ts and runs its flows in a visible browser, one step at a time:
// the decider (decider.ts) chooses an action from the screenshot and the page's numbered controls,
// the step is shown for a person to accept (review.ts), and then carried out. Tokens, cost and
// seconds are counted per step and per flow, next to the planner's, so "one model plans and a
// decider runs" and other combinations end up in one table per site.
//
// `bun bench/flows.ts --plan bench/runs/penny-de/<plan run> [--decider perplexity/pplx-decider-v1.1-27b]
//   [--images on|off] [--flows g1,g4] [--limit 5]
//   [--text-model z-ai/glm-5.3-flash] [--text-reasoning low] [--max-steps 15]
//   [--storage-state login.json]`
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Page } from 'playwright';
import { imageDataUri } from '#lib/server/models.ts';
import { settle, watchNavigations, type NavigationWatch } from '../crawler/agent.ts';
import {
	closeBrowser,
	launchBrowser,
	loadPage,
	openContext,
	viewportScreenshot
} from '../crawler/capture.ts';
import { decideNextAction, resolveDecider, type Decision, type HistoryEntry } from './decider.ts';
import { parseModelSpec, REASONING_LEVELS, resolveModel, type Reasoning } from './models.ts';
import { closeReview, reviewStep, type ReviewChoice } from './review.ts';
import type { Snapshot } from './snapshot.ts';

const { values } = parseArgs({
	options: {
		// A run folder written by plan.ts.
		plan: { type: 'string' },
		// A decision model on OpenRouter, like typesafe/jev-1.13, which reads no images.
		decider: { type: 'string', default: 'perplexity/pplx-decider-v1.1-27b' },
		// Whether the decider sees the screenshot. Without it, it reads the visible page text, the
		// way Jev Ultrafast works. On by default for deciders that read images.
		images: { type: 'string', default: 'on' },
		// Flow ids from the plan, separated by commas. Without them, the first --limit flows the
		// agent can run, in the plan's order.
		flows: { type: 'string' },
		limit: { type: 'string', default: '5' },
		// Writes what to type when the decider chooses to type, since a decider cannot write.
		'text-model': { type: 'string', default: 'z-ai/glm-5.3-flash' },
		'text-reasoning': { type: 'string', default: 'low' },
		'max-steps': { type: 'string', default: '15' },
		// A Playwright storage state saved after logging in, for flows that need the login.
		'storage-state': { type: 'string' }
	}
});

if (values.plan === undefined) {
	throw new Error('Name the plan to run: --plan bench/runs/penny-de/<a plan run folder>');
}
if (!REASONING_LEVELS.includes(values['text-reasoning'] as Reasoning)) {
	throw new Error(`--text-reasoning must be one of ${REASONING_LEVELS.join(', ')}`);
}
const textReasoning = values['text-reasoning'] as Reasoning;
const maxSteps = Number(values['max-steps']);
const textSpec = parseModelSpec(values['text-model']);
const textModel = await resolveModel(textSpec.id, { needsImages: false });
const decider = await resolveDecider(values.decider);
if (values.images !== 'on' && values.images !== 'off') throw new Error('--images must be on or off');
if (values.images === 'on' && !decider.readsImages) {
	throw new Error(`${decider.id} reads no images, so run it with --images off`);
}
const withImage = values.images === 'on';

// --- the plan -----------------------------------------------------------------------------------

interface PlannedFlow {
	id: string;
	continues_from: string;
	title: string;
	goal: string;
	start: string;
	needs_login: boolean;
	needs_payment_or_private_data: boolean;
	success: string;
}

const planDirectory = values.plan.replace(/\/$/, '');
const siteDirectory = dirname(planDirectory);
const planRun = JSON.parse(await readFile(join(planDirectory, 'result.json'), 'utf8')) as {
	model: { id: string };
	plan?: { areas: { name: string; flows: PlannedFlow[] }[] };
};
if (planRun.plan === undefined) throw new Error(`${planDirectory} holds no plan, the planning run failed`);
const snapshot = JSON.parse(
	await readFile(join(siteDirectory, 'snapshot', 'page.json'), 'utf8')
) as Snapshot;

const plannedFlows = planRun.plan.areas.flatMap((area) =>
	area.flows.map((flow) => ({ ...flow, area: area.name }))
);
const flowsById = new Map(plannedFlows.map((flow) => [flow.id, flow]));

type AreaFlow = PlannedFlow & { area: string };

/** The flows that have to run before this one, oldest first, or an error for a broken chain. */
function ancestorsOf(flow: AreaFlow): AreaFlow[] | string {
	const ancestors: AreaFlow[] = [];
	let parentId = flow.continues_from;
	while (parentId !== '') {
		const parent = flowsById.get(parentId);
		if (parent === undefined) return `continues from ${parentId}, which the plan does not have`;
		if (ancestors.includes(parent) || parent === flow) return `its chain loops back on itself at ${parentId}`;
		ancestors.unshift(parent);
		parentId = parent.continues_from;
	}
	return ancestors;
}

/** Why a flow cannot run in this benchmark, or undefined when it can. */
function whyNotRunnable(flow: AreaFlow): string | undefined {
	const chain = ancestorsOf(flow);
	if (typeof chain === 'string') return chain;
	if ([...chain, flow].some((link) => link.needs_payment_or_private_data)) {
		return 'it needs payment details or personal data';
	}
	if (values['storage-state'] === undefined && [...chain, flow].some((link) => link.needs_login)) {
		return 'it needs the login, and no --storage-state was given';
	}
	return undefined;
}

let selected: AreaFlow[];
if (values.flows !== undefined) {
	const ids = values.flows.split(',').map((id) => id.trim());
	const unknown = ids.filter((id) => !flowsById.has(id));
	if (unknown.length > 0) throw new Error(`The plan has no flows ${unknown.join(', ')}`);
	selected = plannedFlows.filter((flow) => ids.includes(flow.id));
} else {
	selected = plannedFlows
		.filter((flow) => whyNotRunnable(flow) === undefined)
		.slice(0, Number(values.limit));
}

// --- running a flow -----------------------------------------------------------------------------

/**
 * The decider sees the screenshot at this size. Perplexity's limit is 2048 tiles of 32 by 32
 * pixels per image, and 1280 by 800 is 1000 tiles, which keeps small text readable.
 */
const SCREENSHOT_MAX_SIDE = 1280;
/**
 * How far one scroll moves, in CSS pixels. Jev Ultrafast's 560 is about two thirds of the 900
 * pixel viewport, so the next screen overlaps the last and nothing is skipped.
 */
const SCROLL_PIXELS = 560;
/** A click on an element that is covered or gone fails after this, and the decider is told so. */
const ACTION_TIMEOUT_MS = 5000;
/** Enough of the visible text to tell two screens apart, as much as the decider reads without images. */
const PAGE_TEXT_CHARACTERS = 6000;
/**
 * A flow whose last this many actions changed nothing is stuck, and ends as blocked. Jev Ultrafast
 * stops at the same count.
 */
const STUCK_AFTER_UNCHANGED_ACTIONS = 3;

type Outcome = 'done' | 'blocked' | 'step_limit' | 'skipped' | 'stopped' | 'error' | 'not_run';

interface StepRecord {
	step: number;
	url: string;
	screenshot: string;
	decision?: Omit<Decision, 'request'>;
	review?: ReviewChoice;
	/** What was carried out, in words. */
	action?: string;
	/** Why the action could not be carried out. */
	actionError?: string;
	/** Whether the visible text or controls differ after the action, see `screenFingerprint`. */
	pageChanged?: boolean;
}

interface FlowRecord {
	id: string;
	title: string;
	area: string;
	goal: string;
	/** Run only to set up a later flow that continues from it. */
	asParentOf?: string;
	outcome: Outcome;
	reason?: string;
	steps: StepRecord[];
	inputTokens: number;
	cost: number;
	seconds: number;
}

/** The decision in words, for the terminal, the panel and the history the decider sees next. */
function describeDecision(decision: Decision): string {
	const option = decision.options[decision.choice];
	return decision.text === undefined ? option : `${option}: "${decision.text}"`;
}

/** The options the decider found next most likely, so a person can see how close it was. */
function runnersUp(decision: Decision): string {
	return Object.entries(decision.probabilities)
		.filter(([option]) => option !== decision.choice)
		.sort((first, second) => second[1] - first[1])
		.slice(0, 3)
		.map(([option, probability]) => `${decision.options[option] ?? option} (${probability.toFixed(2)})`)
		.join(', ');
}

/**
 * What the screen shows: the URL, the title, the visible text and the controls on screen with what
 * they hold. Two screens with the same fingerprint look the same to a person. Jev Ultrafast compares
 * the same things, so a scroll that reveals new content counts as a change and one at the bottom of
 * the page does not, where a screenshot hash would also change with every animation.
 */
async function screenFingerprint(page: Page): Promise<string> {
	const text = await page.evaluate(
		(maxCharacters) => window.pageInspector!.viewportText(maxCharacters),
		PAGE_TEXT_CHARACTERS
	);
	const { scrollY, innerHeight } = await page.evaluate(() => ({
		scrollY: window.scrollY,
		innerHeight: window.innerHeight
	}));
	const controls = (await page.evaluate(() => window.pageInspector!.clickables()))
		.filter((clickable) => clickable.visible && clickable.rect.y + clickable.rect.h > scrollY && clickable.rect.y < scrollY + innerHeight)
		.map((clickable) => `${clickable.role} ${clickable.name} ${clickable.value ?? ''}`);
	return JSON.stringify([page.url(), await page.title(), text, controls]);
}

/** Carries out the decision on the element with that number, and says what was done. */
async function carryOut(page: Page, decision: Decision): Promise<string> {
	const element = page.locator(`[data-refs-clickable="${decision.target}"]`);
	switch (decision.operation) {
		case 'CLICK':
			// A link that opens a new tab would leave this page behind, so it opens here instead.
			await element.evaluate((node) => node.removeAttribute('target'));
			await element.click({ timeout: ACTION_TIMEOUT_MS });
			return `clicked [${decision.target}]`;
		case 'TYPE_TEXT':
			await element.fill(decision.text ?? '', { timeout: ACTION_TIMEOUT_MS });
			return `typed "${decision.text}" into [${decision.target}]`;
		case 'PRESS_ENTER':
			await page.keyboard.press('Enter');
			return 'pressed Enter';
		case 'SCROLL_DOWN':
			await page.mouse.wheel(0, SCROLL_PIXELS);
			return 'scrolled down';
		case 'SCROLL_UP':
			await page.mouse.wheel(0, -SCROLL_PIXELS);
			return 'scrolled up';
		case 'BACK':
			await page.goBack();
			return 'went back';
		default:
			return decision.operation;
	}
}

/** Thrown when the person chose Stop, to end the run after the results are written. */
class RunStopped extends Error {}

/**
 * Runs one flow on the page from where it is now, one reviewed step at a time. Screenshots go into
 * `directory`, and the record says how the flow ended.
 */
async function runFlow(
	page: Page,
	navigations: NavigationWatch,
	flow: AreaFlow,
	label: { position: string; asParentOf?: string },
	directory: string
): Promise<FlowRecord> {
	const record: FlowRecord = {
		id: flow.id,
		title: flow.title,
		area: flow.area,
		goal: flow.goal,
		asParentOf: label.asParentOf,
		outcome: 'step_limit',
		steps: [],
		inputTokens: 0,
		cost: 0,
		seconds: 0
	};
	const parentNote = label.asParentOf === undefined ? '' : `, to set up ${label.asParentOf}`;
	console.log(`\n━━ ${label.position}: ${flow.title} (${flow.id}, ${flow.area}${parentNote}) ━━`);
	console.log(`Goal: ${flow.goal}`);
	console.log(`Done when: ${flow.success}`);
	await mkdir(directory, { recursive: true });

	const history: HistoryEntry[] = [];
	for (let step = 1; step <= maxSteps; step++) {
		await settle(page, navigations);
		const clickables = await page.evaluate(() => window.pageInspector!.clickables({ mark: true }));
		const scroll = await page.evaluate(() => ({
			scrollY: window.scrollY,
			viewportWidth: window.innerWidth,
			viewportHeight: window.innerHeight,
			pageHeight: document.documentElement.scrollHeight
		}));
		const pageText = withImage
			? ''
			: await page.evaluate(
					(maxCharacters) => window.pageInspector!.viewportText(maxCharacters),
					PAGE_TEXT_CHARACTERS
				);
		const screenshot = await viewportScreenshot(page);
		const screenshotFile = `step-${String(step).padStart(2, '0')}.png`;
		await writeFile(join(directory, screenshotFile), screenshot);
		const stepRecord: StepRecord = { step, url: page.url(), screenshot: screenshotFile };
		record.steps.push(stepRecord);
		console.log(`\nStep ${step} · ${page.url()}`);

		let decision: Decision;
		try {
			decision = await decideNextAction({
				decider,
				withImage,
				goal: flow.goal,
				success: flow.success,
				url: page.url(),
				title: await page.title(),
				screenshotUri: withImage ? (await imageDataUri(screenshot, SCREENSHOT_MAX_SIDE)).uri : '',
				pageText,
				clickables,
				scroll,
				history,
				canPressEnter: history.at(-1)?.action.startsWith('type into') === true,
				textModel,
				textUpstream: textSpec.upstream,
				textReasoning
			});
		} catch (error) {
			// The decider or the text model failed; the flow ends here, and the run goes on.
			record.outcome = 'error';
			record.reason = (error as Error).message;
			console.log(`  Failed: ${record.reason}`);
			return record;
		}
		const { request: _request, ...decisionRecord } = decision;
		stepRecord.decision = decisionRecord;
		// Written as soon as there is something new, so a run stopped during the review keeps it.
		await writeFile(join(directory, 'steps.json'), JSON.stringify(record, null, '\t'));
		record.inputTokens += decision.inputTokens;
		record.cost += decision.cost;
		record.seconds += decision.seconds;

		const described = describeDecision(decision);
		const details = [
			`${decision.confidence.toFixed(2)} sure, out of ${Object.keys(decision.options).length} options`,
			`then: ${runnersUp(decision)}`,
			`${decision.inputTokens} tokens · $${Number(decision.cost.toPrecision(3))} · ${decision.seconds.toFixed(2)} s`
		];
		console.log(`  Decision: ${described}`);
		for (const detail of details) console.log(`  ${detail}`);

		const review = await reviewStep(page, {
			flowTitle: flow.title,
			position: `${label.position}, step ${step}${parentNote}`,
			goal: flow.goal,
			success: flow.success,
			decision: described,
			details,
			target: decision.target
		});
		stepRecord.review = review;
		if (review === 'stop') throw new RunStopped();
		if (review === 'skip') {
			record.outcome = 'skipped';
			record.reason = 'skipped in review';
			return record;
		}
		if (decision.operation === 'DONE' || decision.operation === 'BLOCKED') {
			record.outcome = decision.operation === 'DONE' ? 'done' : 'blocked';
			return record;
		}

		const before = await screenFingerprint(page);
		try {
			stepRecord.action = await carryOut(page, decision);
		} catch (error) {
			// A covered, detached or disabled element. The decider sees in the history that nothing
			// changed and chooses again.
			stepRecord.actionError = (error as Error).message.split('\n')[0];
			console.log(`  Could not carry it out: ${stepRecord.actionError}`);
		}
		await settle(page, navigations);
		stepRecord.pageChanged = (await screenFingerprint(page)) !== before;
		history.push({ step, action: described, pageChanged: stepRecord.pageChanged });
		// Written after every step, so a run stopped with Ctrl-C still leaves its steps behind.
		await writeFile(join(directory, 'steps.json'), JSON.stringify(record, null, '\t'));

		const recent = history.slice(-STUCK_AFTER_UNCHANGED_ACTIONS);
		if (recent.length === STUCK_AFTER_UNCHANGED_ACTIONS && recent.every((entry) => !entry.pageChanged)) {
			record.outcome = 'blocked';
			record.reason = `the last ${STUCK_AFTER_UNCHANGED_ACTIONS} actions changed nothing on the screen`;
			return record;
		}
	}
	record.reason = `no DONE within ${maxSteps} steps`;
	return record;
}

// --- the run ------------------------------------------------------------------------------------

const runDirectory = join(
	siteDirectory,
	`${new Date().toISOString().replace(/[:.]/g, '-')}-flows-${decider.id.replaceAll('/', '_')}`
);
await mkdir(runDirectory, { recursive: true });
console.log(
	`Running ${selected.length} flows of ${basename(planDirectory)} (planned by ${planRun.model.id}) with ${decider.id}, text by ${textModel.id}`
);

const records: FlowRecord[] = [];
const browser = await launchBrowser({ headed: true });
try {
	for (const [position, flow] of selected.entries()) {
		const flowLabel = `Flow ${position + 1} of ${selected.length}`;
		const notRunnable = whyNotRunnable(flow);
		if (notRunnable !== undefined) {
			console.log(`\n${flowLabel}: ${flow.title} (${flow.id}) is not run, because ${notRunnable}`);
			records.push({
				id: flow.id,
				title: flow.title,
				area: flow.area,
				goal: flow.goal,
				outcome: 'not_run',
				reason: notRunnable,
				steps: [],
				inputTokens: 0,
				cost: 0,
				seconds: 0
			});
			continue;
		}

		// Every flow gets a fresh browser context, as a visitor on a new device would, with the
		// login when one was given. A chain runs its parents first, in that same context.
		const storageState =
			values['storage-state'] === undefined ? undefined : await readFile(values['storage-state'], 'utf8');
		const { context } = await openContext(browser, 'desktop', { storageState });
		const page = await context.newPage();
		const navigations = watchNavigations(page);
		// whyNotRunnable above has checked that the chain is whole.
		const chain = [...(ancestorsOf(flow) as AreaFlow[]), flow];
		const root = chain[0];
		const startUrl = new URL(root.start === '' ? '/' : root.start, snapshot.url).href;
		await loadPage(page, startUrl, { waitForBanner: true });

		try {
			for (const link of chain) {
				const isParent = link !== flow;
				const flowRecord = await runFlow(
					page,
					navigations,
					link,
					{ position: flowLabel, asParentOf: isParent ? flow.id : undefined },
					join(runDirectory, isParent ? `${flow.id}-parent-${link.id}` : flow.id)
				);
				records.push(flowRecord);
				console.log(`→ ${flowRecord.outcome}${flowRecord.reason === undefined ? '' : `: ${flowRecord.reason}`}`);
				if (isParent && flowRecord.outcome !== 'done') {
					records.push({
						id: flow.id,
						title: flow.title,
						area: flow.area,
						goal: flow.goal,
						outcome: 'not_run',
						reason: `its parent ${link.id} ended as ${flowRecord.outcome}`,
						steps: [],
						inputTokens: 0,
						cost: 0,
						seconds: 0
					});
					break;
				}
			}
		} finally {
			await context.close();
		}
	}
} catch (error) {
	// Stop in the review ends the run; everything recorded so far is still written below.
	if (!(error instanceof RunStopped)) throw error;
	console.log('\nStopped.');
} finally {
	await closeBrowser(browser);
	closeReview();
}

// --- the report ---------------------------------------------------------------------------------

function dollars(amount: number): string {
	return `$${Number(amount.toPrecision(3))}`;
}

for (const record of records) {
	const folder = record.asParentOf === undefined ? record.id : `${record.asParentOf}-parent-${record.id}`;
	if (record.steps.length === 0) continue;
	await writeFile(join(runDirectory, folder, 'steps.json'), JSON.stringify(record, null, '\t'));
}

const measured = records.filter((record) => record.outcome !== 'not_run');
const totals = {
	steps: measured.reduce((sum, record) => sum + record.steps.length, 0),
	inputTokens: measured.reduce((sum, record) => sum + record.inputTokens, 0),
	cost: measured.reduce((sum, record) => sum + record.cost, 0),
	seconds: measured.reduce((sum, record) => sum + record.seconds, 0)
};
const flowsDone = records.filter((record) => record.asParentOf === undefined && record.outcome === 'done').length;
const flowsTried = records.filter((record) => record.asParentOf === undefined && record.outcome !== 'not_run').length;
const costPerDoneFlow = flowsDone === 0 ? '' : dollars(totals.cost / flowsDone);

const flowRows = records.map((record) => {
	const confidences = record.steps
		.map((step) => step.decision?.confidence)
		.filter((confidence) => confidence !== undefined);
	const meanConfidence =
		confidences.length === 0
			? ''
			: (confidences.reduce((sum, confidence) => sum + confidence, 0) / confidences.length).toFixed(2);
	const role = record.asParentOf === undefined ? '' : ` (sets up ${record.asParentOf})`;
	return `| ${record.id}${role} | ${record.title} | ${record.outcome} | ${record.reason ?? ''} | ${record.steps.length} | ${meanConfidence} | ${record.inputTokens} | ${dollars(record.cost)} | ${record.seconds.toFixed(1)} |`;
});

const summary = `# Running flows of ${basename(planDirectory)}

Planned by ${planRun.model.id}, run by ${decider.id}, with text written by ${textModel.id} (reasoning ${textReasoning}). At most ${maxSteps} steps per flow. Every step was reviewed by a person before it ran; each flow's folder has a screenshot per step and \`steps.json\` with every decision and its probabilities.

${flowsDone} of ${flowsTried} flows reached their goal, in ${totals.steps} steps, for ${totals.inputTokens} decider input tokens and ${dollars(totals.cost)}${costPerDoneFlow === '' ? '' : ` (${costPerDoneFlow} per flow done)`}, ${totals.seconds.toFixed(1)} s of model time.

"Confidence" is the decider's mean confidence in the action it chose. Seconds count model time only, not the browser or the review.

| Flow | Title | Outcome | Reason | Steps | Confidence | Input tokens | Cost | Seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${flowRows.join('\n')}
`;
await writeFile(join(runDirectory, 'summary.md'), summary);
console.log(
	`\n${flowsDone} of ${flowsTried} flows done in ${totals.steps} steps. Total ${dollars(totals.cost)} for ${totals.inputTokens} decider input tokens${costPerDoneFlow === '' ? '' : `, ${costPerDoneFlow} per flow done`}, ${totals.seconds.toFixed(1)} s of model time.`
);
console.log(`summary: ${join(runDirectory, 'summary.md')}`);

// Every run on the site adds its row here, so planner and decider combinations end up in one table.
const resultsPath = join(siteDirectory, 'flows-results.md');
const RESULTS_HEADER = `# Running flows, all runs

| Run | Plan | Planner | Decider | Text model | Done | Tried | Steps | Input tokens | Cost | Per flow done | Seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
`;
try {
	await writeFile(resultsPath, RESULTS_HEADER, { flag: 'wx' });
} catch (error) {
	// The table already exists from an earlier run, which is the usual case.
	if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}
await appendFile(
	resultsPath,
	`| ${basename(runDirectory)} | ${basename(planDirectory)} | ${planRun.model.id} | ${decider.id} | ${textModel.id} | ${flowsDone} | ${flowsTried} | ${totals.steps} | ${totals.inputTokens} | ${dollars(totals.cost)} | ${costPerDoneFlow} | ${totals.seconds.toFixed(1)} |\n`
);
console.log(`all runs: ${resultsPath}`);
