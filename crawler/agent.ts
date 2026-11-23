// The browser agent: asking the model for the next action, refusing the ones that are unsafe,
// carrying out the rest in the page, and waiting for what they cause. The one place that knows how
// a decision is made is `decideNextAction`; everything else works on the action it returns.
import { errors, type Page, type Request } from 'playwright';
import { chat, imageDataUri, modelConfigFromEnv } from '#lib/server/models.ts';
import { decideWithDecider } from './decider.ts';
import { agentGoal, type PlannedFlow } from './goals.ts';
import type { ProbedControl } from './page.ts';
import type { FlowRecording } from './recording.ts';
import {
	isDestructive,
	isSameSite,
	isThirdPartyLogin,
	normalizeUrl,
	typedFieldRefusal,
	typedTextRefusal,
	type DemoIdentity
} from './rules.ts';

/** A scroll of this share of the viewport shows new content and keeps some of the old for orientation. */
const SCROLL_SHARE = 0.75;
/** After an action, the page is quiet when nothing in the DOM has changed for this long. */
const DOM_QUIET_MS = 300;
/** Some pages animate forever (carousels, tickers), so the wait for quiet is capped. */
const DOM_QUIET_CAP_MS = 1500;
/** Many sites never reach network idle, so waiting for it is capped. */
const NETWORK_IDLE_CAP_MS = 3000;
/** A page that has not answered by then is not coming; the run goes on and sees what is there. */
const NAVIGATION_CAP_MS = 20_000;
/** JPEG keeps the upload to the model server small; `imageDataUri` shrinks it further. */
const AGENT_SCREENSHOT_QUALITY = 85;

const models = modelConfigFromEnv(process.env);

/** Where an action lands, in CSS pixels of the viewport. */
interface PagePoint {
	x: number;
	y: number;
}

/**
 * What an action points at. Only coordinates exist today. A backend that picks a row of an
 * accessibility table instead would add an `element` variant here, and `resolveTarget` would find
 * that element and return its centre; nothing else in the run would change.
 */
export type ActionTarget = { kind: 'point'; point: PagePoint };

export type AgentAction = { thought: string } & (
	| { action: 'click'; element: string; target: ActionTarget }
	| { action: 'type'; element: string; target: ActionTarget; text: string; pressEnter: boolean }
	/** `bottom` jumps to the end of the page, where the footer links are. */
	| { action: 'scroll'; direction: 'up' | 'down' | 'bottom' }
	| { action: 'back' }
	| { action: 'wait' }
	/** Submits the field just typed into. */
	| { action: 'press_enter' }
	/** Not chosen by the model: the crawler opens the link of a verification email itself. */
	| { action: 'open_link'; url: string }
	| { action: 'done'; reason: string }
	| { action: 'give_up'; reason: string }
);

export interface HistoryEntry {
	action: string;
	result: string;
}

/** What the model knows about the demo account of a site while it works on a goal. */
export interface AgentIdentity extends DemoIdentity {
	/** A one-time code from the verification email, once it arrived, for the model to type. */
	verificationCode?: string;
}

/** The password is replaced in text that is logged or stored, though the model itself needs it. */
function hidePassword(text: string, identity: AgentIdentity | undefined): string {
	return identity === undefined ? text : text.replaceAll(identity.password, '<password>');
}

/** Long accessibility trees would push the screenshot out of the context window. */
const MAX_ARIA_SNAPSHOT_CHARACTERS = 6000;
/** Small models repeat a failing action forever, so a streak of identical results gets called out. */
const STUCK_STEPS_BEFORE_WARNING = 3;
/** Only the latest steps matter for deciding the next one, and older ones just cost tokens. */
const MAX_HISTORY_STEPS = 12;
/** The agent has to read small link text, so it gets a sharper image than the classifier. */
const AGENT_MAX_SIDE = 1600;
/**
 * Without a length limit the model sometimes rambles until it runs out of tokens. A thought is a
 * couple of sentences, and a target description is one line.
 */
const MAX_THOUGHT_CHARACTERS = 300;
const MAX_ELEMENT_CHARACTERS = 120;
/** Enough for the longest action the schema allows, and little more, so a runaway answer is cut short. */
const ACTION_MAX_TOKENS = 600;
const GROUNDING_MAX_TOKENS = 40;

/** Holo is trained to emit click targets as integers in [0, 1000], relative to the image it saw. */
const HOLO_COORDINATE_RANGE = 1000;
/**
 * Holo's own prompt for grounding: a description of an element in, a click point out. Choosing
 * what to do and pointing at it are separate skills, and the model is far more accurate at
 * pointing when asked only that. In a first test, clicks placed while also deciding were often
 * 50 pixels off a link, which is why the agent decides first and then looks the element up.
 */
function groundingPrompt(target: string): string {
	return (
		'Localize an element on the GUI image according to the provided target and output a click ' +
		'position. You must output a valid JSON following the format: ' +
		`{"visible": <boolean>, "x": <integer in [0, ${HOLO_COORDINATE_RANGE}]>, "y": <integer in [0, ${HOLO_COORDINATE_RANGE}]>}. ` +
		`Set visible to false if the target is not shown in the image. Your target is: ${target}`
	);
}

/** Holo's browser-agent cookbook prompt, with "act with your tools" changed to what happens here. */
const AGENT_SYSTEM_PROMPT =
	'You are a web agent. You see the browser through screenshots and decide the next action.';

/**
 * The JSON schema of one action. `thought` comes first so the model reasons before it commits:
 * property order is what the model server follows while decoding, and a model that has to name the
 * action before explaining it will explain whatever it already chose.
 */
function actionSchema(name: string, properties: Record<string, object>): object {
	const allProperties = {
		thought: {
			type: 'string',
			maxLength: MAX_THOUGHT_CHARACTERS,
			description: 'One short sentence on why this is the next step.'
		},
		action: { const: name },
		...properties
	};
	return {
		type: 'object',
		properties: allProperties,
		required: Object.keys(allProperties),
		additionalProperties: false
	};
}

const ELEMENT_SCHEMA = {
	type: 'string',
	maxLength: MAX_ELEMENT_CHARACTERS,
	description: 'The target element, with its visible text.'
};
const REASON_SCHEMA = {
	type: 'string',
	maxLength: MAX_THOUGHT_CHARACTERS,
	description: 'What was reached, or why the goal cannot be reached.'
};

/**
 * One schema that allows exactly the actions below, so the answer always parses and always
 * carries the arguments its action needs.
 */
const AGENT_ACTION_SCHEMA = {
	anyOf: [
		actionSchema('click', { element: ELEMENT_SCHEMA }),
		actionSchema('type', {
			element: ELEMENT_SCHEMA,
			text: { type: 'string' },
			press_enter: { type: 'boolean' }
		}),
		actionSchema('scroll', { direction: { enum: ['up', 'down'] } }),
		actionSchema('back', {}),
		actionSchema('wait', {}),
		actionSchema('done', { reason: REASON_SCHEMA }),
		actionSchema('give_up', { reason: REASON_SCHEMA })
	]
};

const AGENT_ACTIONS_PROMPT = `Actions you can take, one per step:
- click: click an element, described by what it is and its visible text.
- type: click an input field and replace its content with text. The text is exactly what goes
  into the field, never with a newline at the end; set press_enter to submit it.
- scroll: scroll the page up or down.
- back: go back to the previous page.
- wait: wait for the page to finish loading or animating.
- done: the goal has been reached, with a reason saying what you found.`;

const GIVE_UP_PROMPT =
	'- give_up: the goal cannot be reached without logging in, paying or leaving the site.';
/** With a demo account logging in is possible, and so is what the site asks for during sign-up. */
const GIVE_UP_WITH_ACCOUNT_PROMPT =
	'- give_up: the goal cannot be reached without paying, a phone number, or leaving the site.';

const NO_ACCOUNT_RULE = '- Never log in, pay, or submit personal data.\n';

/** The rules and credentials of a goal on a site that has a demo account. */
function accountRules(identity: AgentIdentity): string {
	const code =
		identity.verificationCode === undefined
			? ''
			: `- A verification email arrived. Its code is ${identity.verificationCode}. If the page ` +
				'asks for a code, type this one.\n';
	return (
		'- This site has a demo account. Use it wherever the goal needs an account: sign up with ' +
		'it when the goal says to create one, and log in with it when the page asks you to. Where ' +
		'an email or a password is asked, type exactly these:\n' +
		`  email: ${identity.email}\n  password: ${identity.password}\n` +
		`  name: ${identity.name} (any made-up name is fine where a name is asked)\n` +
		'  Where a username is asked, make one up from the name, with letters and digits only, no @.\n' +
		'- The type action clicks the field itself, so do not click a field before typing into it.\n' +
		"- Sign up and log in with email and password only. Never use 'Continue with Google', " +
		'GitHub, Apple, single sign-on or a passkey.\n' +
		'- Never enter payment details, a phone number, a postal address or any other real ' +
		'personal data. If a step needs them, call give_up and say what it asked for.\n' +
		"- If a CAPTCHA appears, fill it so we're not getting blocked.\n" +
		'- If the page says an email was sent and asks you to confirm, wait: the crawler reads the ' +
		'inbox itself and tells you the code or opens the link.\n' +
		'- Never delete anything, invite other people or change billing.\n' +
		code
	);
}

/** What the model answers: the schema above as a type. */
type ModelAction = { thought: string } & (
	| { action: 'click'; element: string }
	| { action: 'type'; element: string; text: string; press_enter: boolean }
	| { action: 'scroll'; direction: 'up' | 'down' }
	| { action: 'back' }
	| { action: 'wait' }
	| { action: 'done'; reason: string }
	| { action: 'give_up'; reason: string }
);

/** A model answer with the position of its element, as fractions of the screenshot. */
interface ProposedAction {
	action: ModelAction;
	/** Missing for actions that point at nothing. */
	point?: PagePoint;
	/** False when the element is not in the screenshot at all. */
	visible: boolean;
}

/**
 * Finds where to click for a described element, as fractions of the image. Also says whether the
 * element is in the image at all, because a model that is asked for a position always gives one.
 */
async function locate(imageUri: string, target: string): Promise<{ visible: boolean } & PagePoint> {
	const answer = await chat(
		models.grounding,
		[
			{
				role: 'user',
				content: [
					{ type: 'image_url', image_url: { url: imageUri } },
					{ type: 'text', text: groundingPrompt(target) }
				]
			}
		],
		{
			schema: {
				name: 'click_point',
				schema: {
					type: 'object',
					properties: {
						visible: { type: 'boolean' },
						x: { type: 'integer', minimum: 0, maximum: HOLO_COORDINATE_RANGE },
						y: { type: 'integer', minimum: 0, maximum: HOLO_COORDINATE_RANGE }
					},
					required: ['visible', 'x', 'y'],
					additionalProperties: false
				}
			},
			maxTokens: GROUNDING_MAX_TOKENS
		}
	);
	const point = JSON.parse(answer) as { visible: boolean; x: number; y: number };
	return {
		visible: point.visible,
		x: point.x / HOLO_COORDINATE_RANGE,
		y: point.y / HOLO_COORDINATE_RANGE
	};
}

/**
 * Asks the model for the next action toward a goal. This is the one place that knows how the
 * decision is made: the screenshot, the page and the history go in, one action comes out. A decider
 * chooses among the page's controls when `REFS_DECIDER_MODEL` is set; otherwise a VLM describes the
 * action and a grounding model points at it. With a demo identity the site has a demo account, whose email, password and name the model
 * fills sign-up and login forms with; without one it never logs in.
 */
export async function decideNextAction(
	flow: Pick<PlannedFlow, 'goal' | 'success'>,
	page: Page,
	history: HistoryEntry[],
	identity?: AgentIdentity
): Promise<AgentAction> {
	if (models.decider !== undefined) {
		return decideWithDecider({
			decider: models.decider,
			textModel: models.vlm,
			goal: flow.goal,
			success: flow.success,
			page,
			history,
			identity
		});
	}
	const goal = agentGoal(flow);
	const screenshot = await page.screenshot({ type: 'jpeg', quality: AGENT_SCREENSHOT_QUALITY });
	const { uri: imageUri } = await imageDataUri(screenshot, AGENT_MAX_SIDE);
	const ariaSnapshot = await page.ariaSnapshot();

	const recentSteps = history.slice(-MAX_HISTORY_STEPS);
	const steps = recentSteps
		.map(
			(step, index) =>
				`${history.length - recentSteps.length + index + 1}. ${step.action}` +
				(step.result === '' ? '' : ` -> ${step.result}`)
		)
		.join('\n');
	// Clicking something and nothing happening is the commonest way to get stuck, and the model
	// tends to come back to the same dead control a few steps later, past the streak check below.
	const deadActions = [
		...new Set(
			history.filter((step) => step.result === 'nothing changed').map((step) => step.action)
		)
	].sort();
	const deadActionsWarning = deadActions
		.map((action) => `- This changed nothing before, so don't do it again: ${action}\n`)
		.join('');
	// The wording of a repeated click varies, but a stuck page reports the same result each time.
	const lastResults = history.slice(-STUCK_STEPS_BEFORE_WARNING).map((step) => step.result);
	const isRepeating =
		lastResults.length === STUCK_STEPS_BEFORE_WARNING &&
		new Set(lastResults).size === 1 &&
		lastResults[0] !== '';
	const repetitionWarning = isRepeating
		? `- The last ${STUCK_STEPS_BEFORE_WARNING} actions all had the same result, so you are ` +
			'stuck. Choose a different action, such as scrolling, or call give_up.\n'
		: '';

	const prompt =
		`Goal: ${goal}\n\nCurrent URL: ${page.url()}\n\n` +
		`Steps so far:\n${steps === '' ? '(none yet)' : steps}\n\n` +
		'Page structure (accessibility tree, may be cut off):\n' +
		`${ariaSnapshot.slice(0, MAX_ARIA_SNAPSHOT_CHARACTERS)}\n\n` +
		`${AGENT_ACTIONS_PROMPT}\n${identity === undefined ? GIVE_UP_PROMPT : GIVE_UP_WITH_ACCOUNT_PROMPT}\n\n` +
		'Choose the single next action. Rules:\n' +
		'- Only click what is visible in the screenshot. If the element you need is not ' +
		'visible, scroll to it first; the page structure may list elements that are off screen.\n' +
		'- Call done as soon as the screenshot shows what the goal asks for, and do not undo it.\n' +
		(identity === undefined ? NO_ACCOUNT_RULE : accountRules(identity)) +
		repetitionWarning +
		deadActionsWarning;

	// The screenshot comes first, and the instructions that would be a system message follow it,
	// so this request starts exactly like the grounding request in `locate`. The model server
	// then reuses its work on the image for the second request instead of reading it again.
	async function propose(promptText: string): Promise<ProposedAction> {
		const answer = await chat(
			models.vlm,
			[
				{
					role: 'user',
					content: [
						{ type: 'image_url', image_url: { url: imageUri } },
						{ type: 'text', text: `${AGENT_SYSTEM_PROMPT}\n\n${promptText}` }
					]
				}
			],
			{
				schema: { name: 'agent_action', schema: AGENT_ACTION_SCHEMA },
				maxTokens: ACTION_MAX_TOKENS
			}
		);
		const action = JSON.parse(answer) as ModelAction;
		if (action.action === 'type') {
			// Models end the text with a newline (or an escaped "\\n") to mean Enter, which would
			// be typed literally.
			let text = action.text.replace(/\n+$/, '');
			while (text.endsWith('\\n')) text = text.slice(0, -2).replace(/\n+$/, '');
			if (text !== action.text) {
				action.text = text;
				action.press_enter = true;
			}
		}
		if (action.action !== 'click' && action.action !== 'type') return { action, visible: true };
		const { visible, x, y } = await locate(imageUri, action.element);
		return { action, point: { x, y }, visible };
	}

	// The page structure lists elements that are off screen, and models click those despite the
	// rule against it. When the element isn't in the screenshot, the model gets one more try with
	// that pointed out; a second miss is clicked anyway, because the grounder can be wrong too.
	let proposed = await propose(prompt);
	if (!proposed.visible && 'element' in proposed.action) {
		proposed = await propose(
			`${prompt}- ${proposed.action.element} is not visible in the screenshot. Scroll to it first.\n`
		);
	}

	const { action: answer, point } = proposed;
	const thought = hidePassword(answer.thought, identity);
	// The model points in fractions of the screenshot, which shows exactly the viewport.
	const viewport = page.viewportSize()!;
	const target: ActionTarget = {
		kind: 'point',
		point: { x: (point?.x ?? 0) * viewport.width, y: (point?.y ?? 0) * viewport.height }
	};
	switch (answer.action) {
		case 'click':
			return { thought, action: 'click', element: answer.element, target };
		case 'type':
			return {
				thought,
				action: 'type',
				element: answer.element,
				target,
				text: answer.text,
				pressEnter: answer.press_enter
			};
		case 'scroll':
			return { thought, action: 'scroll', direction: answer.direction };
		case 'back':
		case 'wait':
			return { thought, action: answer.action };
		case 'done':
		case 'give_up':
			return { thought, action: answer.action, reason: answer.reason };
	}
}

export function resolveTarget(target: ActionTarget): PagePoint {
	return target.point;
}

/** One line of history for the model, like `click 'Pricing link'`. The password is left out. */
export function describeAction(action: AgentAction, identity?: AgentIdentity): string {
	switch (action.action) {
		case 'click':
			return `click '${action.element}'`;
		case 'type':
			return `type '${hidePassword(action.text, identity)}' into '${action.element}'`;
		case 'scroll':
			return action.direction === 'bottom' ? 'scroll to the bottom' : `scroll ${action.direction}`;
		case 'open_link':
			return 'open the verification link from the email';
		case 'press_enter':
			return 'press Enter';
		default:
			return action.action;
	}
}

/**
 * Why an action must not be carried out, or undefined when it may be. The crawler only looks: it
 * never presses a control that changes something, never leaves the site, and never types personal
 * data. Both a link's target and the control's name are checked, because a button may navigate.
 * With a demo identity, submitting a sign-up or login form is allowed, but logging in through
 * another service is not, because the account is an email and a password.
 */
export function refusalReason(
	control: ProbedControl | undefined,
	described: string,
	siteHost: string,
	identity?: AgentIdentity
): string | undefined {
	const name = control?.name || described;
	if (isDestructive(name, { hasDemoAccount: identity !== undefined })) {
		return `"${name}" would change something, and the crawler only looks`;
	}
	if (isThirdPartyLogin(name)) {
		return `"${name}" logs in through another service, and the demo account has an email and a password`;
	}
	if (control?.href !== undefined) {
		const destination = normalizeUrl(control.href);
		if (destination === undefined || !isSameSite(destination, siteHost)) {
			const where = URL.canParse(control.href)
				? new URL(control.href).host || control.href
				: control.href;
			return `"${name}" leads away from the site, to ${where}`;
		}
	}
	return undefined;
}

/**
 * Carries out an action in the browser. Returns why it refused to when typing would enter
 * personal data other than the demo identity, which can only be known once the click has put the
 * focus in the field.
 */
export async function carryOut(
	page: Page,
	action: AgentAction,
	recording: FlowRecording,
	identity?: AgentIdentity
): Promise<string | undefined> {
	switch (action.action) {
		case 'click':
			await recording.click(resolveTarget(action.target));
			return undefined;
		case 'type': {
			const textRefusal = typedTextRefusal(action.text, identity);
			if (textRefusal !== undefined) return hidePassword(textRefusal, identity);
			await recording.click(resolveTarget(action.target));
			const field = await page.evaluate(() => window.pageInspector!.focusedField());
			if (field === undefined) return `there is no text field at "${action.element}" to type into`;
			const fieldRefusal = typedFieldRefusal(field, action.text, identity);
			if (fieldRefusal !== undefined) return `"${action.element}" ${fieldRefusal}`;
			// The text replaces what the field holds; typing after earlier text garbled searches.
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.type(action.text);
			if (action.pressEnter) await page.keyboard.press('Enter');
			return undefined;
		}
		case 'scroll': {
			if (action.direction === 'bottom') {
				// A wheel as long as the page reaches its end, and lazy content on the way still loads.
				const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
				await page.mouse.wheel(0, pageHeight);
				return undefined;
			}
			const { height } = page.viewportSize()!;
			const distance = height * SCROLL_SHARE * (action.direction === 'down' ? 1 : -1);
			await page.mouse.wheel(0, distance);
			return undefined;
		}
		case 'back':
			await page.goBack();
			return undefined;
		case 'press_enter':
			await page.keyboard.press('Enter');
			return undefined;
		case 'open_link':
			await page.goto(action.url, { waitUntil: 'domcontentloaded' });
			return undefined;
		default:
			// 'wait' needs nothing but the settling every action gets; done and give_up never get here.
			return undefined;
	}
}

/** Says when the page has no navigation of its own document in flight. */
export interface NavigationWatch {
	untilIdle(): Promise<void>;
}

/**
 * Follows the requests for the page's own document. A link's request can still be waiting on the
 * server after the DOM has gone quiet, and a screenshot taken while the new document replaces
 * the old one fails ("Unable to capture screenshot", on GitHub's sign-up link). Requests are
 * followed from the moment the page exists, because the one a click starts is sent before `settle`
 * is called.
 */
export function watchNavigations(page: Page): NavigationWatch {
	const inFlight = new Set<Request>();
	let waiting: (() => void)[] = [];
	page.on('request', (request) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) inFlight.add(request);
	});
	const ended = (request: Request) => {
		if (!inFlight.delete(request) || inFlight.size > 0) return;
		for (const resolve of waiting) resolve();
		waiting = [];
	};
	// A redirect ends its request with a finish, and a navigation that another one replaces with
	// a failure, so these two cover every way a request leaves the set.
	page.on('requestfinished', ended);
	page.on('requestfailed', ended);
	return {
		untilIdle: () =>
			inFlight.size === 0
				? Promise.resolve()
				: new Promise((resolve) => {
						waiting.push(resolve);
					})
	};
}

/**
 * Waits for the effects of an action: the DOM quiet for a moment, then any navigation it started
 * loaded. A click that navigates destroys the page the first wait runs in, which is not an error.
 */
export async function settle(page: Page, navigations: NavigationWatch): Promise<void> {
	try {
		await page.evaluate(
			({ quietMs, capMs }) =>
				new Promise<void>((resolve) => {
					let quietTimer = setTimeout(finish, quietMs);
					const observer = new MutationObserver(() => {
						clearTimeout(quietTimer);
						quietTimer = setTimeout(finish, quietMs);
					});
					observer.observe(document, {
						subtree: true,
						childList: true,
						attributes: true,
						characterData: true
					});
					const capTimer = setTimeout(finish, capMs);
					function finish() {
						observer.disconnect();
						clearTimeout(quietTimer);
						clearTimeout(capTimer);
						resolve();
					}
				}),
			{ quietMs: DOM_QUIET_MS, capMs: DOM_QUIET_CAP_MS }
		);
	} catch (error) {
		if (!(error instanceof Error && /Execution context was destroyed/.test(error.message)))
			throw error;
	}
	let capTimer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		navigations.untilIdle(),
		new Promise((resolve) => {
			capTimer = setTimeout(resolve, NAVIGATION_CAP_MS);
		})
	]);
	clearTimeout(capTimer);
	// Once its request is done the new document has replaced the old one, and this waits for it.
	await page.waitForLoadState('domcontentloaded');
	try {
		await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_CAP_MS });
	} catch (error) {
		if (!(error instanceof errors.TimeoutError)) throw error;
	}
}
