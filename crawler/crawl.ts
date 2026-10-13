// One crawl: pops the best URL from the frontier, captures it, queues its links and explores its
// in-page states (menus, dialogs, tabs), until the frontier is empty or a limit is reached.
import type { Page } from 'playwright';
import type { Surreal } from 'surrealdb';
import { localMedia, type MediaStore } from '#lib/server/media.ts';
import { RecordId } from '#lib/server/surreal.ts';
import type { Rect } from '#lib/types.ts';
import {
	captureScreen,
	closeBrowser,
	computeDomSig,
	dHash,
	hammingDistance,
	loadPage,
	openBrowser,
	viewportScreenshot,
	type CapturedScreen
} from './capture.ts';
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
import type { ClickTarget } from './page.ts';
import {
	displayPath,
	fetchRobots,
	chooseClickTargets,
	isCrawlable,
	isSameSite,
	normalizeUrl,
	pathShape,
	scoreLink,
	urlKey,
	type LinkRegion,
	type Robots
} from './rules.ts';
import { applySiteMetadata, setCover } from './site-metadata.ts';
import { enrichCrawl } from './enrich.ts';
import { cutFlows } from './flows.ts';
import { recordFlowVideosInNewProcess } from './videos.ts';

/** Where screenshots and crops are written; the SvelteKit app serves the same directory. */
export const MEDIA_ROOT = process.env.MEDIA_DIR ?? 'data/media';

/** A site has many pages of the same template (/blog/a, /blog/b); a few of each is enough. */
const MAX_PAGES_PER_SHAPE = 3;
/** Pages with identical structure are the same template even when their URLs look different. */
const MAX_PAGES_PER_DOM_SIG = 3;
/** Pause between page loads, to be polite to the server. */
const POLITENESS_DELAY_MS = 500;
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
	/** Captured in-page states, a subset of `screens`. */
	states = 0;
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
	): Promise<void> {
		await this.db
			.query('RELATE $from->action->$to CONTENT $content', {
				from: new RecordId('screen', from),
				to: new RecordId('screen', to),
				content: { crawl: this.job.id, kind, label, region, rect }
			})
			.collect();
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
	await processFinishedCrawl(db, job);
}

/**
 * Cuts the flows of a finished crawl, then has the models fill in page types, section labels,
 * embeddings and flow names. Neither is part of the capture, so a failure only gets logged and the
 * crawl stays done: the model service may simply not be running, and `bun run flows` and
 * `bun run enrich` catch up later.
 */
async function processFinishedCrawl(db: Surreal, job: CrawlJob): Promise<void> {
	try {
		await cutFlows(db, String(job.id.id));
		await recordFlowVideosInNewProcess(String(job.id.id));
	} catch (error) {
		console.warn(
			`cutting or recording flows failed: ${error instanceof Error ? error.message : error}`
		);
	}
	try {
		await enrichCrawl(db, job.id);
	} catch (error) {
		console.warn(`enrichment skipped: ${error instanceof Error ? error.message : error}`);
	}
}

async function runCrawl(db: Surreal, job: CrawlJob, signal: AbortSignal): Promise<void> {
	const [sites] = await db.query('SELECT * FROM $id', { id: job.site }).collect<[SiteRow[]]>();
	const ctx = new CrawlContext(db, localMedia(MEDIA_ROOT), job, sites[0], signal);

	// Buttons stored by earlier crawls of this site, so they aren't stored again.
	const [storedButtons] = await db
		.query(
			"SELECT name, rect FROM element WHERE site = $site AND viewport = $viewport AND kind = 'button'",
			{
				site: job.site,
				viewport: job.viewport
			}
		)
		.collect<[{ name: string; rect: Rect }[]]>();
	for (const button of storedButtons)
		ctx.knownButtons.add(buttonKey(job.viewport, button.name, button.rect));

	const { browser, context, userAgent } = await openBrowser(job.viewport);
	try {
		const page = await context.newPage();
		// Pop-ups (target=_blank links, OAuth windows) are never wanted; native dialogs would block the page.
		context.on('page', (popup) => {
			if (popup !== page) void popup.close();
		});
		page.on('dialog', (dialog) => void dialog.dismiss());

		const robots = await fetchRobots(new URL(ctx.site.url).origin, userAgent);
		await new PageCrawler(ctx, page, robots).run();
	} finally {
		await closeBrowser(browser);
	}
}

// --- frontier ----------------------------------------------------------------------------------

interface Candidate {
	url: string;
	depth: number;
	/** Higher scores are visited first. */
	score: number;
	/** Page screen whose link led here (undefined for the start URL). */
	fromScreen?: string;
	label: string;
	/** Where on the source screen the link sat. */
	region: LinkRegion;
	/** Rect of the link on the source screen, when it was visible. */
	rect?: Rect;
}

/** Best-first queue of URLs still to visit. */
class Frontier {
	private readonly pending = new Map<string, Candidate>();
	/** Every key ever added, so a URL is never queued twice, even after it was visited. */
	private readonly known = new Set<string>();

	/** Adds a candidate. A better-scoring duplicate that's still waiting replaces the old one. */
	add(candidate: Candidate): void {
		const key = urlKey(candidate.url);
		const waiting = this.pending.get(key);
		if (waiting) {
			if (candidate.score > waiting.score) this.pending.set(key, candidate);
			return;
		}
		if (this.known.has(key)) return;
		this.known.add(key);
		this.pending.set(key, candidate);
	}

	/** Marks a URL as handled (e.g. the final URL after a redirect) without queueing it. */
	markKnown(url: string): void {
		const key = urlKey(url);
		this.known.add(key);
		this.pending.delete(key);
	}

	isKnown(url: string): boolean {
		return this.known.has(urlKey(url));
	}

	/** Removes and returns the highest-scoring candidate; ties go to the one added first. */
	pop(): Candidate | undefined {
		let bestKey: string | undefined;
		let best: Candidate | undefined;
		for (const [key, candidate] of this.pending) {
			if (!best || candidate.score > best.score) {
				best = candidate;
				bestKey = key;
			}
		}
		if (bestKey !== undefined) this.pending.delete(bestKey);
		return best;
	}
}

// --- the crawl loop ------------------------------------------------------------------------------

/** Click exploration only runs on pages up to this depth, with this many clicks per page. */
const CLICK_MAX_DEPTH = 1;
const MAX_CLICKS_PER_PAGE = 5;
/** Share of max_screens that in-page states may use, so exploration can't starve real pages. */
const MAX_STATE_SHARE = 0.35;
/** Viewport images whose dHash differs by at least this many bits count as a visual change. */
const STATE_HASH_DISTANCE = 6;
/** Two states of the same page closer than this are the same state reached twice. */
const SAME_STATE_HASH_DISTANCE = 3;
/** Time for a menu or dialog to animate open (and for a navigation to start). */
const AFTER_CLICK_MS = 700;

class PageCrawler {
	private readonly frontier = new Frontier();
	/** Captured pages per path shape (first segment + segment count). */
	private readonly pagesPerShape = new Map<string, number>();
	/** Captured pages per dom_sig. */
	private readonly pagesPerDomSig = new Map<string, number>();
	private lastError = '';
	/** Cookie banners are waited for on the first page load only; later pages carry the consent cookie. */
	private hasLoadedAPage = false;

	constructor(
		private readonly ctx: CrawlContext,
		private readonly page: Page,
		private readonly robots: Robots
	) {}

	async run(): Promise<void> {
		const { ctx } = this;
		this.frontier.add({
			url: ctx.site.url,
			depth: 0,
			score: Infinity,
			label: '',
			region: 'other'
		});

		for (;;) {
			await ctx.throwIfStopped();
			if (ctx.screens >= ctx.job.max_screens) break;
			const candidate = this.frontier.pop();
			if (!candidate) break;

			try {
				await this.visit(candidate);
			} catch (error) {
				// One broken page (timeout, download, crash) must not end the crawl.
				if (error instanceof CrawlCancelled) throw error;
				this.lastError = error instanceof Error ? error.message.split('\n')[0] : String(error);
				console.warn(`  skipped ${candidate.url}: ${this.lastError}`);
			}
			await this.page.waitForTimeout(POLITENESS_DELAY_MS);
		}

		if (ctx.screens === 0) throw new Error(`Could not capture any page. ${this.lastError}`.trim());
	}

	/** Loads one candidate and captures it unless it is a duplicate, off-site or disallowed. */
	private async visit(candidate: Candidate): Promise<void> {
		const { ctx, page } = this;
		const isStartPage = candidate.depth === 0;
		if (!isStartPage && !this.hasShapeRoom(candidate.url)) return;
		if (!isStartPage && !this.robots.isAllowed(displayPath(candidate.url))) return;

		await ctx.setActivity(`Capturing ${displayPath(candidate.url)}`);
		const response = await loadPage(page, candidate.url, { waitForBanner: !this.hasLoadedAPage });
		this.hasLoadedAPage = true;
		const contentType = response?.headers()['content-type'] ?? '';
		if (response && (response.status() >= 400 || !contentType.includes('html'))) {
			throw new Error(`HTTP ${response.status()} ${contentType}`.trim());
		}

		// Redirects can land on a page we already have, or leave the site.
		const finalUrl = normalizeUrl(page.url());
		if (!finalUrl || !isSameSite(finalUrl, ctx.site.host)) {
			// Without a start page there is nothing to crawl, so say where it went instead of
			// silently ending with "could not capture any page".
			if (isStartPage) throw new Error(`The start page redirected off the site, to ${page.url()}`);
			return;
		}
		const wasRedirected = urlKey(finalUrl) !== urlKey(candidate.url);
		if (wasRedirected && this.frontier.isKnown(finalUrl)) return;
		this.frontier.markKnown(finalUrl);
		if (!isStartPage && !this.hasShapeRoom(finalUrl)) return;

		const domSig = await computeDomSig(page);
		if (!isStartPage && (this.pagesPerDomSig.get(domSig) ?? 0) >= MAX_PAGES_PER_DOM_SIG) return;

		const screen = await captureScreen({
			page,
			ctx,
			kind: 'page',
			url: finalUrl,
			depth: candidate.depth,
			domSig
		});
		const shape = pathShape(finalUrl);
		this.pagesPerShape.set(shape, (this.pagesPerShape.get(shape) ?? 0) + 1);
		this.pagesPerDomSig.set(domSig, (this.pagesPerDomSig.get(domSig) ?? 0) + 1);
		if (candidate.fromScreen) {
			await ctx.createAction(
				candidate.fromScreen,
				screen.id,
				'navigate',
				candidate.label,
				candidate.region,
				candidate.rect
			);
		}

		if (isStartPage) await this.recordSiteDetails(screen);
		if (candidate.depth < ctx.job.max_depth)
			await this.queueLinks(screen, finalUrl, candidate.depth);

		// States may use only part of max_screens, so exploration can't starve the real pages.
		const stateBudget = Math.max(1, Math.floor(ctx.job.max_screens * MAX_STATE_SHARE));
		const hasRoom = ctx.screens < ctx.job.max_screens && ctx.states < stateBudget;
		if (candidate.depth <= CLICK_MAX_DEPTH && hasRoom) {
			await this.exploreClicks({ url: finalUrl, depth: candidate.depth, screen }, stateBudget);
		}
	}

	private hasShapeRoom(url: string): boolean {
		return (this.pagesPerShape.get(pathShape(url)) ?? 0) < MAX_PAGES_PER_SHAPE;
	}

	/** Site name, description and icon, and the start page as the card preview. Never fatal. */
	private async recordSiteDetails(screen: CapturedScreen): Promise<void> {
		try {
			await applySiteMetadata(this.ctx, this.page);
			await setCover(this.ctx, screen.id);
		} catch (error) {
			console.warn(`  site details failed: ${error instanceof Error ? error.message : error}`);
		}
	}

	/** Adds the page's same-site links to the frontier, scored by where they sit and what they point at. */
	private async queueLinks(screen: CapturedScreen, pageUrl: string, depth: number): Promise<void> {
		const links = await this.page.evaluate(() => window.pageInspector!.links());
		for (const link of links) {
			const url = normalizeUrl(link.href);
			if (!url || urlKey(url) === urlKey(pageUrl)) continue;
			if (!isSameSite(url, this.ctx.site.host) || !isCrawlable(url)) continue;
			// A link only gets an edge rect if it lies inside the (capped) full-page image.
			const rect =
				link.rect && link.rect.y + link.rect.h <= screen.fullHeight ? link.rect : undefined;
			this.frontier.add({
				url,
				depth: depth + 1,
				score: scoreLink(url, depth + 1, link.region),
				fromScreen: screen.id,
				label: link.text,
				region: link.region,
				rect
			});
		}
	}

	// --- click exploration -----------------------------------------------------------------------

	/**
	 * Clicks menu triggers, tabs, popups and accordions on a page and captures the clicks that
	 * visibly change it as 'state' screens. Header menu triggers are tried first; destructive or
	 * committing controls and duplicate labels are never clicked.
	 */
	private async exploreClicks(target: ExplorationTarget, stateBudget: number): Promise<void> {
		const { ctx, page } = this;
		const targets = await page.evaluate(() => window.pageInspector!.clickTargets());
		const chosen = chooseClickTargets(targets, MAX_CLICKS_PER_PAGE);

		const capturedHashes: string[] = [];
		for (const [position, clickTarget] of chosen.entries()) {
			if (ctx.screens >= ctx.job.max_screens || ctx.states >= stateBudget) return;
			await ctx.throwIfStopped();
			await ctx.setActivity(`Clicking '${clickTarget.name}' on ${displayPath(target.url)}`);

			try {
				// Every click starts from a fresh load so states don't build on each other. The first
				// one reuses the page we just captured, which hasn't been touched.
				let toClick = clickTarget;
				if (position > 0) {
					await loadPage(page, target.url, { waitForBanner: false });
					const reloaded = await page.evaluate(() => window.pageInspector!.clickTargets());
					const sameControl = reloaded.find((candidate) => candidate.name === clickTarget.name);
					if (!sameControl) continue;
					toClick = sameControl;
				}
				await this.clickAndCapture(target, toClick, capturedHashes);
			} catch (error) {
				if (error instanceof CrawlCancelled) throw error;
				console.warn(
					`  click '${clickTarget.name}' failed: ${error instanceof Error ? error.message : error}`
				);
			}
		}
	}

	/**
	 * Clicks a control and works out what happened: it navigated (a link we hadn't seen, queued),
	 * it changed the page (captured as a state) or nothing visible happened (ignored).
	 */
	private async clickAndCapture(
		target: ExplorationTarget,
		clickTarget: ClickTarget,
		capturedHashes: string[]
	): Promise<void> {
		const { ctx, page } = this;
		await page.evaluate(() => window.pageInspector!.snapshotVisible());
		// A real mouse click at the control's centre, as a user would: it also triggers hover menus.
		// (Page coordinates equal viewport coordinates because the page is scrolled to the top.)
		await page.mouse.click(
			clickTarget.rect.x + clickTarget.rect.w / 2,
			clickTarget.rect.y + clickTarget.rect.h / 2
		);
		await page.waitForTimeout(AFTER_CLICK_MS);

		if (urlKey(page.url()) !== urlKey(target.url)) {
			const destination = page.url();
			if (isSameSite(destination, ctx.site.host) && isCrawlable(destination)) {
				this.frontier.add({
					url: destination,
					depth: target.depth + 1,
					score: scoreLink(destination, target.depth + 1, 'nav'),
					fromScreen: target.screen.id,
					label: clickTarget.name,
					region: clickTarget.region,
					rect: clickTarget.rect
				});
			}
			return;
		}

		const newPanels = await page.evaluate(() => window.pageInspector!.newPanels());
		const imageHash = await dHash(await viewportScreenshot(page));
		const changedLook = hammingDistance(target.screen.imageHash, imageHash) >= STATE_HASH_DISTANCE;
		const openedPanel = newPanels.some((panel) => panel.hasPanelRole);
		if (!openedPanel && !changedLook) return;
		if (capturedHashes.some((seen) => hammingDistance(seen, imageHash) < SAME_STATE_HASH_DISTANCE))
			return;
		capturedHashes.push(imageHash);

		const state = await captureScreen({
			page,
			ctx,
			kind: 'state',
			url: page.url(),
			depth: target.depth,
			domSig: await computeDomSig(page),
			baseline: target.screen.foundElements,
			newPanels
		});
		ctx.states++;
		await ctx.createAction(
			target.screen.id,
			state.id,
			'click',
			clickTarget.name,
			clickTarget.region,
			clickTarget.rect
		);
	}
}

/** The page that click exploration is working on. */
interface ExplorationTarget {
	url: string;
	depth: number;
	screen: CapturedScreen;
}
