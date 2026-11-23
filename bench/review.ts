// Letting a person approve each step before it runs. The decision is printed in the terminal, and
// in the browser its target is outlined and a panel shows the flow, the goal and the decision, with
// buttons to accept it, skip the flow or stop the run. Enter in the terminal accepts too, so a page
// that replaces itself while the panel is open (a carousel, a redirect) cannot strand the run.
import { createInterface } from 'node:readline';
import { errors, type Page } from 'playwright';

export type ReviewChoice = 'accept' | 'skip' | 'stop';

/** What the panel shows about the step under review. */
export interface ReviewInfo {
	flowTitle: string;
	/** Like "flow 2 of 5, step 3". */
	position: string;
	goal: string;
	success: string;
	/** The decision in words, like `CLICK [12] link "Angebote"`. */
	decision: string;
	/** Further lines, like the confidence and the runners-up. */
	details: string[];
	/** The element to outline, by its mark from `clickables({ mark: true })`. */
	target?: number;
}

const terminal = createInterface({ input: process.stdin });

/** What Playwright says when the page a call ran in navigated away or closed. */
const PAGE_GONE = /Execution context was destroyed|Target page, context or browser has been closed|navigat/i;

/** The next line typed in the terminal, and a way to stop listening when the browser answered first. */
function terminalChoice(): { choice: Promise<ReviewChoice>; cancel: () => void } {
	let cancel = () => {};
	const choice = new Promise<ReviewChoice>((resolve) => {
		const onLine = (line: string) => {
			const answer = line.trim().toLowerCase();
			if (answer === 's') resolve('skip');
			else if (answer === 'q') resolve('stop');
			else resolve('accept');
		};
		terminal.once('line', onLine);
		cancel = () => terminal.off('line', onLine);
	});
	return { choice, cancel };
}

/** Shows the step in the browser and waits for a person to accept it, skip the flow or stop. */
export async function reviewStep(page: Page, info: ReviewInfo): Promise<ReviewChoice> {
	console.log('  Enter or Accept in the browser to carry it out, s to skip the flow, q to stop.');
	if (info.target !== undefined) {
		// The panel outlines the element where it is on screen, so it has to be scrolled into view.
		await page
			.locator(`[data-refs-clickable="${info.target}"]`)
			.scrollIntoViewIfNeeded({ timeout: 2000 })
			.catch((error: Error) => {
				// An element that cannot be scrolled to is still worth reviewing; the outline is missing then.
				if (!(error instanceof errors.TimeoutError)) throw error;
				console.log('  (could not scroll to the element, so it is not outlined)');
			});
	}
	await page.evaluate(showPanel, info);

	const fromTerminal = terminalChoice();
	const fromBrowser = page
		.waitForFunction(() => (window as unknown as { refsReview?: string }).refsReview, null, {
			timeout: 0,
			polling: 100
		})
		.then(async (handle) => (await handle.jsonValue()) as ReviewChoice)
		.catch((error: Error) => {
			// The page navigated away under the panel, so only the terminal can answer now.
			if (!PAGE_GONE.test(error.message)) throw error;
			return new Promise<ReviewChoice>(() => {});
		});
	const choice = await Promise.race([fromTerminal.choice, fromBrowser]);
	fromTerminal.cancel();
	await page.evaluate(removePanel).catch((error: Error) => {
		// Gone with the page it was on, which is fine: there is nothing left to remove.
		if (!PAGE_GONE.test(error.message)) throw error;
	});
	return choice;
}

/** Stops listening to the terminal, so the process can end. */
export function closeReview(): void {
	terminal.close();
}

// --- in the page --------------------------------------------------------------------------------
// These two run inside the browser through page.evaluate, so they may only use what they are given.

function showPanel(info: ReviewInfo): void {
	const target = window as unknown as {
		refsReview?: string;
		refsReviewKeys?: (event: KeyboardEvent) => void;
	};
	target.refsReview = undefined;
	document.getElementById('refs-review')?.remove();

	const root = document.createElement('div');
	root.id = 'refs-review';
	root.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';

	if (info.target !== undefined) {
		const element = document.querySelector(`[data-refs-clickable="${info.target}"]`);
		const box = element?.getBoundingClientRect();
		if (box !== undefined) {
			const outline = document.createElement('div');
			outline.style.cssText = `position: fixed; left: ${box.left - 4}px; top: ${box.top - 4}px; width: ${box.width + 8}px; height: ${box.height + 8}px; border: 3px solid #ff2d55; border-radius: 6px; box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.25);`;
			const label = document.createElement('div');
			label.textContent = String(info.target);
			label.style.cssText = 'position: absolute; top: -26px; left: -3px; background: #ff2d55; color: white; font: 600 13px Inter, system-ui, sans-serif; padding: 3px 8px; border-radius: 6px;';
			outline.append(label);
			root.append(outline);
		}
	}

	const panel = document.createElement('div');
	panel.style.cssText = 'position: fixed; right: 16px; bottom: 16px; width: 420px; max-height: 70vh; overflow: auto; pointer-events: auto; background: #111; color: #eee; font: 13px/1.45 Inter, system-ui, sans-serif; border-radius: 14px; padding: 16px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);';
	const line = (text: string, style: string) => {
		const paragraph = document.createElement('div');
		paragraph.textContent = text;
		paragraph.style.cssText = style;
		panel.append(paragraph);
	};
	line(info.position, 'color: #999; font-size: 12px;');
	line(info.flowTitle, 'font-size: 16px; font-weight: 600; margin: 2px 0 8px;');
	line(`Goal: ${info.goal}`, 'margin-bottom: 4px;');
	line(`Done when: ${info.success}`, 'color: #bbb; margin-bottom: 12px;');
	line(info.decision, 'font-weight: 600; color: #ff8fa6; margin-bottom: 4px;');
	for (const detail of info.details) line(detail, 'color: #bbb; font-size: 12px;');

	const buttons = document.createElement('div');
	buttons.style.cssText = 'display: flex; gap: 8px; margin-top: 14px;';
	const choices = [
		{ choice: 'accept', label: 'Accept (Enter)', style: 'background: #fff; color: #111;' },
		{ choice: 'skip', label: 'Skip flow', style: 'background: #333; color: #eee;' },
		{ choice: 'stop', label: 'Stop', style: 'background: #333; color: #eee;' }
	];
	for (const { choice, label, style } of choices) {
		const button = document.createElement('button');
		button.textContent = label;
		button.style.cssText = `all: initial; cursor: pointer; font: 600 13px Inter, system-ui, sans-serif; padding: 8px 14px; border-radius: 999px; ${style}`;
		button.onclick = () => {
			target.refsReview = choice;
		};
		buttons.append(button);
	}
	panel.append(buttons);
	root.append(panel);
	document.documentElement.append(root);

	// Kept on the window so removePanel can take it away again: left in place, it would swallow the
	// Enter the agent presses to submit a search.
	target.refsReviewKeys = (event: KeyboardEvent) => {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		target.refsReview = 'accept';
	};
	window.addEventListener('keydown', target.refsReviewKeys, true);
}

function removePanel(): void {
	const target = window as unknown as { refsReviewKeys?: (event: KeyboardEvent) => void };
	if (target.refsReviewKeys !== undefined) {
		window.removeEventListener('keydown', target.refsReviewKeys, true);
		target.refsReviewKeys = undefined;
	}
	document.getElementById('refs-review')?.remove();
}
