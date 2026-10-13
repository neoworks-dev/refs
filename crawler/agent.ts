// The browser agent: asking the model for the next action, refusing the ones that are unsafe,
// carrying out the rest in the page, and waiting for what they cause. The one place that knows how
// a decision is made is `decideNextAction`; everything else works on the action it returns.
import { errors, type Page } from 'playwright';
import { DEVICE_SCALE_FACTOR } from './capture.ts';
import { callModel } from './enrich.ts';
import type { ProbedControl } from './page.ts';
import type { FlowRecording } from './recording.ts';
import {
	isDestructive,
	isPersonalDataField,
	isSameSite,
	looksLikePersonalData,
	normalizeUrl
} from './rules.ts';

/** A scroll of this share of the viewport shows new content and keeps some of the old for orientation. */
const SCROLL_SHARE = 0.75;
/** After an action, the page is quiet when nothing in the DOM has changed for this long. */
const DOM_QUIET_MS = 300;
/** Some pages animate forever (carousels, tickers), so the wait for quiet is capped. */
const DOM_QUIET_CAP_MS = 1500;
/** Many sites never reach network idle, so waiting for it is capped. */
const NETWORK_IDLE_CAP_MS = 3000;
/** JPEG keeps the upload to the model service small; the service shrinks the image anyway. */
const AGENT_SCREENSHOT_QUALITY = 85;

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
	| { action: 'scroll'; direction: 'up' | 'down' }
	| { action: 'back' }
	| { action: 'wait' }
	| { action: 'done'; reason: string }
	| { action: 'give_up'; reason: string }
);

export interface HistoryEntry {
	action: string;
	result: string;
}

/**
 * Asks the model for the next action toward a goal. This is the one place that knows how the
 * decision is made: the screenshot, the accessibility tree and the history go in, one action comes
 * out. The model service answers with click coordinates in pixels of the screenshot we sent.
 */
export async function decideNextAction(
	goal: string,
	page: Page,
	history: HistoryEntry[]
): Promise<AgentAction> {
	const form = new FormData();
	const screenshot = await page.screenshot({ type: 'jpeg', quality: AGENT_SCREENSHOT_QUALITY });
	form.set(
		'screenshot',
		new Blob([screenshot as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
		'screenshot.jpg'
	);
	form.set('goal', goal);
	form.set('url', page.url());
	form.set('aria_snapshot', await page.ariaSnapshot());
	form.set('history', JSON.stringify(history));
	const answer = await callModel<{
		action: AgentAction['action'];
		thought: string;
		element?: string;
		x?: number;
		y?: number;
		text?: string;
		press_enter?: boolean;
		direction?: 'up' | 'down';
		reason?: string;
	}>('/next-action', form);

	const { thought } = answer;
	// The screenshot has device pixels, the page works in CSS pixels.
	const target: ActionTarget = {
		kind: 'point',
		point: { x: (answer.x ?? 0) / DEVICE_SCALE_FACTOR, y: (answer.y ?? 0) / DEVICE_SCALE_FACTOR }
	};
	switch (answer.action) {
		case 'click':
			return { thought, action: 'click', element: answer.element!, target };
		case 'type':
			return {
				thought,
				action: 'type',
				element: answer.element!,
				target,
				text: answer.text!,
				pressEnter: answer.press_enter ?? false
			};
		case 'scroll':
			return { thought, action: 'scroll', direction: answer.direction! };
		case 'back':
		case 'wait':
			return { thought, action: answer.action };
		case 'done':
		case 'give_up':
			return { thought, action: answer.action, reason: answer.reason! };
	}
}

export function resolveTarget(target: ActionTarget): PagePoint {
	return target.point;
}

/** One line of history for the model, like `click 'Pricing link'`. */
export function describeAction(action: AgentAction): string {
	switch (action.action) {
		case 'click':
			return `click '${action.element}'`;
		case 'type':
			return `type '${action.text}' into '${action.element}'`;
		case 'scroll':
			return `scroll ${action.direction}`;
		default:
			return action.action;
	}
}

/**
 * Why an action must not be carried out, or undefined when it may be. The crawler only looks: it
 * never presses a control that changes something, never leaves the site, and never types personal
 * data. Both a link's target and the control's name are checked, because a button may navigate.
 */
export function refusalReason(
	control: ProbedControl | undefined,
	described: string,
	siteHost: string
): string | undefined {
	const name = control?.name || described;
	if (isDestructive(name)) return `"${name}" would change something, and the crawler only looks`;
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
 * personal data, which can only be known once the click has put the focus in the field.
 */
export async function carryOut(
	page: Page,
	action: AgentAction,
	recording: FlowRecording
): Promise<string | undefined> {
	switch (action.action) {
		case 'click':
			await recording.click(resolveTarget(action.target));
			return undefined;
		case 'type': {
			if (looksLikePersonalData(action.text)) {
				return `the model wanted to type "${action.text}", which is personal data`;
			}
			await recording.click(resolveTarget(action.target));
			const field = await page.evaluate(() => window.pageInspector!.focusedField());
			if (field === undefined) return `there is no text field at "${action.element}" to type into`;
			if (isPersonalDataField(field)) {
				return `"${action.element}" asks for personal data (${field.type} field "${field.text}")`;
			}
			// The text replaces what the field holds; typing after earlier text garbled searches.
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.type(action.text);
			if (action.pressEnter) await page.keyboard.press('Enter');
			return undefined;
		}
		case 'scroll': {
			const { height } = page.viewportSize()!;
			const distance = height * SCROLL_SHARE * (action.direction === 'down' ? 1 : -1);
			await page.mouse.wheel(0, distance);
			return undefined;
		}
		case 'back':
			await page.goBack();
			return undefined;
		default:
			// 'wait' needs nothing but the settling every action gets; done and give_up never get here.
			return undefined;
	}
}

/**
 * Waits for the effects of an action: the DOM quiet for a moment, then any navigation it started
 * loaded. A click that navigates destroys the page the first wait runs in, which is not an error.
 */
export async function settle(page: Page): Promise<void> {
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
	await page.waitForLoadState('domcontentloaded');
	try {
		await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_CAP_MS });
	} catch (error) {
		if (!(error instanceof errors.TimeoutError)) throw error;
	}
}
