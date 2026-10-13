// What exploration is doing right now, written for the live panel on a site's page (see the
// `live_goal` table). Each goal being tried reports after every step and ends its row when it is
// done, so the table never holds more than the goals currently running.
import type { Page } from 'playwright';
import type { Surreal } from 'surrealdb';
import { RecordId } from '#lib/server/surreal.ts';
import type { Viewport } from '#lib/types.ts';

/** Small enough to send every couple of seconds per goal, still enough to read a page's headings. */
const LIVE_SCREENSHOT_QUALITY = 60;

export interface LiveGoalStep {
	crawl: RecordId;
	site: RecordId;
	viewport: Viewport;
	slot: number;
	goal: string;
	step: number;
	thought?: string;
	action?: string;
	signedIn?: boolean;
}

/** Shows the goal's latest step and the page as it looks now in the live panel. */
export async function reportLiveGoal(db: Surreal, page: Page, step: LiveGoalStep): Promise<void> {
	// Device scale 1 would be enough for the panel, but the context is set up at 2 for capturing,
	// and the JPEG at quality 60 keeps it to about 130 KB.
	const screenshot = await page.screenshot({ type: 'jpeg', quality: LIVE_SCREENSHOT_QUALITY });
	await db
		.query(
			`UPSERT live_goal SET crawl = $crawl, site = $site, viewport = $viewport, slot = $slot,
			   goal = $goal, step = $step, thought = $thought, action = $action,
			   signed_in = $signed_in, screenshot = $screenshot
			 WHERE crawl = $crawl AND slot = $slot`,
			{
				crawl: step.crawl,
				site: step.site,
				viewport: step.viewport,
				slot: step.slot,
				goal: step.goal,
				step: step.step,
				thought: step.thought,
				action: step.action,
				signed_in: step.signedIn,
				screenshot: new Uint8Array(screenshot).buffer
			}
		)
		.collect();
}

/** Takes a finished goal out of the live panel. */
export async function endLiveGoal(db: Surreal, crawl: RecordId, slot: number): Promise<void> {
	await db.query('DELETE live_goal WHERE crawl = $crawl AND slot = $slot', { crawl, slot }).collect();
}

/** Clears a crawl's rows when its exploration ends, including those of goals that crashed. */
export async function clearLiveGoals(db: Surreal, crawl: RecordId): Promise<void> {
	await db.query('DELETE live_goal WHERE crawl = $crawl', { crawl }).collect();
}
