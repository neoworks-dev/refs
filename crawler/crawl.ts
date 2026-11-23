// One crawl: opens the landing page and captures it, signs up for a demo account when the site
// has one, has the model plan the flows worth recording, and tries each of them (explore.ts).
import type { Browser } from 'playwright';
import type { Surreal } from 'surrealdb';
import { localMedia, type MediaStore } from '#lib/server/media.ts';
import { RecordId } from '#lib/server/surreal.ts';
import type { Rect } from '#lib/types.ts';
import { closeBrowser, launchBrowser, loadPage, openContext } from './capture.ts';
import { buttonKey } from './dedupe.ts';
import {
	finishCrawl,
	getCrawlStatus,
	purgeCrawlData,
	requeueCrawl,
	stampFinished,
	type CrawlJob,
	type SiteRow
} from './jobs.ts';
import { enrichCrawl } from './enrich.ts';
import { DEFAULT_MAX_TRAJECTORIES, captureLanding, exploreSite, type Landing } from './explore.ts';
import { clearLiveGoals } from './live.ts';
import { isSameSite, normalizeUrl, type LinkRegion } from './rules.ts';
import { applySiteMetadata, setCover } from './site-metadata.ts';
import { ScreenIndex } from './trajectory.ts';

/** Where screenshots and crops are written; the SvelteKit app serves the same directory. */
export const MEDIA_ROOT = process.env.MEDIA_DIR ?? 'data/media';

/** How often the crawl status is re-read to notice a cancel from the UI. */
const CANCEL_CHECK_INTERVAL_MS = 2000;

/** Thrown to unwind a running crawl: the UI cancelled it, or the worker is shutting down. */
export class CrawlCancelled extends Error {
	constructor(readonly reason: 'cancelled' | 'interrupted') {
		super(reason);
	}
}

/** State shared by everything that takes part in one crawl: connections, counters and progress. */
export class CrawlContext {
	/** Captured screens (pages and states). */
	screens = 0;
	elements = 0;
	/** Capture order, stored as `screen.seq`. */
	nextSeq = 0;
	/** Button identities already stored for this site and viewport (see dedupe.ts). */
	readonly knownButtons = new Set<string>();

	private lastCancelCheck = 0;

	constructor(
		readonly db: Surreal,
		readonly media: MediaStore,
		readonly job: CrawlJob,
		readonly site: SiteRow,
		/** Aborted by the worker on SIGINT/SIGTERM. */
		readonly signal: AbortSignal
	) {}

	get siteId(): string {
		return String(this.job.site.id);
	}

	/** Shows what the crawler is doing right now in the UI. */
	async setActivity(activity: string): Promise<void> {
		console.log(`[${this.siteId}/${this.job.viewport}] ${activity}`);
		await this.db
			.query('UPDATE $id SET activity = $activity', { id: this.job.id, activity })
			.collect();
	}

	/** Persists the counters shown in the UI. */
	async saveProgress(): Promise<void> {
		await this.db
			.query('UPDATE $id SET screens = $screens, elements = $elements', {
				id: this.job.id,
				screens: this.screens,
				elements: this.elements
			})
			.collect();
	}

	/** Throws when the worker is shutting down or the UI cancelled this crawl. */
	async throwIfStopped(): Promise<void> {
		if (this.signal.aborted) throw new CrawlCancelled('interrupted');
		const now = Date.now();
		if (now - this.lastCancelCheck < CANCEL_CHECK_INTERVAL_MS) return;
		this.lastCancelCheck = now;
		if ((await getCrawlStatus(this.db, this.job.id)) === 'cancelled')
			throw new CrawlCancelled('cancelled');
	}

	/** Records how the crawler got from one screen to another. */
	async createAction(
		from: string,
		to: string,
		kind: 'navigate' | 'click',
		label: string,
		region: LinkRegion,
		rect?: Rect
	): Promise<RecordId> {
		const [created] = await this.db
			.query('RELATE $from->action->$to CONTENT $content', {
				from: new RecordId('screen', from),
				to: new RecordId('screen', to),
				content: { crawl: this.job.id, kind, label, region, rect }
			})
			.collect<[{ id: RecordId }[]]>();
		return created[0].id;
	}
}

/** What happens to a crawl when the process is told to stop. */
export type InterruptPolicy = 'requeue' | 'fail';

/**
 * Runs a claimed crawl to completion and records the outcome on the crawl record: done, failed
 * (with the error), or left alone when the UI cancelled it.
 */
export async function executeCrawl(
	db: Surreal,
	job: CrawlJob,
	signal: AbortSignal,
	onInterrupt: InterruptPolicy
): Promise<void> {
	try {
		// An earlier run of this crawl may have been interrupted half-way.
		await purgeCrawlData(db, MEDIA_ROOT, job);
		await runCrawl(db, job, signal);
		await finishCrawl(db, job.id, {});
	} catch (error) {
		if (error instanceof CrawlCancelled && error.reason === 'cancelled') {
			await stampFinished(db, job.id);
		} else if (error instanceof CrawlCancelled && onInterrupt === 'requeue') {
			await requeueCrawl(db, job.id);
		} else {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`crawl ${job.id.id} failed: ${message}`);
			await finishCrawl(db, job.id, { error: message });
		}
		return;
	}
	// The models describe what was captured. That is not part of the capture, so a failure only
	// gets logged and the crawl stays done: `bun run enrich` catches up later.
	try {
		await enrichCrawl(db, job.id);
	} catch (error) {
		console.warn(`enrichment skipped: ${error instanceof Error ? error.message : error}`);
	}
}

/**
 * The context of a crawl that already has screens, or none yet: counters and capture order carry
 * on from what is stored, and the buttons stored by crawls of this site are known, so they aren't
 * stored again.
 */
export async function createCrawlContext(
	db: Surreal,
	job: CrawlJob,
	signal: AbortSignal
): Promise<CrawlContext> {
	const [sites, [crawl], lastSeqs, storedButtons] = await db
		.query(
			`SELECT * FROM $site;
			 SELECT screens, elements FROM $crawl;
			 SELECT VALUE seq FROM screen WHERE crawl = $crawl ORDER BY seq DESC LIMIT 1;
			 SELECT name, rect FROM element WHERE site = $site AND viewport = $viewport AND kind = 'button'`,
			{ site: job.site, crawl: job.id, viewport: job.viewport }
		)
		.collect<
			[SiteRow[], { screens: number; elements: number }[], number[], { name: string; rect: Rect }[]]
		>();
	const ctx = new CrawlContext(db, localMedia(MEDIA_ROOT), job, sites[0], signal);
	ctx.screens = crawl.screens;
	ctx.elements = crawl.elements;
	ctx.nextSeq = lastSeqs.length === 0 ? 0 : lastSeqs[0] + 1;
	for (const button of storedButtons)
		ctx.knownButtons.add(buttonKey(job.viewport, button.name, button.rect));
	return ctx;
}

async function runCrawl(db: Surreal, job: CrawlJob, signal: AbortSignal): Promise<void> {
	const ctx = await createCrawlContext(db, job, signal);

	// One browser for the whole crawl, with a context of its own for the landing page and for every
	// flow. Launching a browser per flow made the second launch fail under Bun: Chrome exited a few
	// seconds in and Playwright never noticed.
	const browser = await launchBrowser();
	try {
		const screenIndex = new ScreenIndex([]);
		const landing = await captureLandingPage(ctx, browser, screenIndex);
		const maxFlows = job.max_trajectories ?? DEFAULT_MAX_TRAJECTORIES;
		if (maxFlows > 0) await exploreSite({ ctx, browser, screenIndex, landing, maxFlows });
	} finally {
		await closeBrowser(browser);
		await clearLiveGoals(db, job.id);
		await db.query('UPDATE $id SET activity = NONE', { id: job.id }).collect();
	}
}

/** Captures the site's landing page as the crawl's first screen, and learns the site's name, icon and cover from it. */
async function captureLandingPage(
	ctx: CrawlContext,
	browser: Browser,
	screenIndex: ScreenIndex
): Promise<Landing> {
	await ctx.setActivity('Capturing the landing page');
	const { context } = await openContext(browser, ctx.job.viewport);
	try {
		const page = await context.newPage();
		// Pop-ups (target=_blank links, OAuth windows) are never wanted; native dialogs would block the page.
		context.on('page', (popup) => {
			if (popup !== page) void popup.close();
		});
		page.on('dialog', (dialog) => void dialog.dismiss());

		const response = await loadPage(page, ctx.site.url, { waitForBanner: true });
		if (response !== null && response.status() >= 400) {
			throw new Error(`The landing page answered HTTP ${response.status()}`);
		}
		// Without a landing page there is nothing to crawl, so say where it went instead of
		// failing later with something vaguer.
		const arrivedAt = normalizeUrl(page.url());
		if (arrivedAt === undefined || !isSameSite(arrivedAt, ctx.site.host)) {
			throw new Error(`The landing page redirected off the site, to ${page.url()}`);
		}

		const landing = await captureLanding(ctx, page, screenIndex, false);
		try {
			await applySiteMetadata(ctx, page);
			await setCover(ctx, landing.screen.id);
		} catch (error) {
			// The name, icon and cover are nice to have; the flows are worth more than losing them.
			console.warn(`  site details failed: ${error instanceof Error ? error.message : error}`);
		}
		return landing;
	} finally {
		await closeBrowser(context);
	}
}
