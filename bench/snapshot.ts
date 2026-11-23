// A snapshot of a website's landing page, taken once and saved, so every model in a benchmark
// sees exactly the same page. Pages change between loads (rotating heroes, A/B tests), and a fair
// comparison needs identical input.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clickable } from '../crawler/page.ts';
import {
	closeBrowser,
	launchBrowser,
	loadPage,
	openContext,
	viewportScreenshot
} from '../crawler/capture.ts';

export interface Snapshot {
	/** Where the browser ended up, after redirects. */
	url: string;
	title: string;
	description: string;
	clickables: Clickable[];
	takenAt: string;
}

const SCREENSHOT_FILE = 'screenshot.png';
const PAGE_FILE = 'page.json';

/**
 * Loads the snapshot saved in `directory`, or takes one there when there is none yet (or when
 * `retake` is set). The page is loaded the way the crawler loads it: cookie banner accepted, lazy
 * content loaded, scrolled back to the top, on the crawler's desktop viewport.
 */
export async function loadOrTakeSnapshot(
	directory: string,
	url: string,
	options: { retake: boolean }
): Promise<{ snapshot: Snapshot; screenshot: Buffer }> {
	const pagePath = join(directory, PAGE_FILE);
	const screenshotPath = join(directory, SCREENSHOT_FILE);
	if (!options.retake) {
		try {
			const snapshot = JSON.parse(await readFile(pagePath, 'utf8')) as Snapshot;
			return { snapshot, screenshot: await readFile(screenshotPath) };
		} catch (error) {
			// No snapshot yet, which is expected on the first run: take one below.
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}

	console.log(`taking a snapshot of ${url}`);
	// Shown on screen, so whoever runs the benchmark sees the page the models will get.
	const browser = await launchBrowser({ headed: true });
	try {
		const { context } = await openContext(browser, 'desktop');
		const page = await context.newPage();
		await loadPage(page, url, { waitForBanner: true });
		const details = await page.evaluate(() => window.pageInspector!.pageDetails());
		const snapshot: Snapshot = {
			url: page.url(),
			title: details.title,
			description: details.description,
			clickables: await page.evaluate(() => window.pageInspector!.clickables()),
			takenAt: new Date().toISOString()
		};
		const screenshot = await viewportScreenshot(page);
		await mkdir(directory, { recursive: true });
		await writeFile(pagePath, JSON.stringify(snapshot, null, '\t'));
		await writeFile(screenshotPath, screenshot);
		console.log(`saved to ${directory}: ${snapshot.clickables.length} clickable elements`);
		return { snapshot, screenshot };
	} finally {
		await closeBrowser(browser);
	}
}
