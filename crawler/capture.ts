// Everything between "a URL" and "a stored screen": launching the browser, loading a page into a
// stable state, taking and encoding screenshots, hashing them, and cropping elements out of them.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
	chromium,
	devices,
	errors,
	type Browser,
	type BrowserContext,
	type Frame,
	type Locator,
	type Page,
	type Response
} from 'playwright';
import { customAlphabet } from 'nanoid';
import sharp from 'sharp';
import { RecordId } from '#lib/server/surreal.ts';
import type { ElementKind, Rect, Viewport } from '#lib/types.ts';
import type { CrawlContext } from './crawl.ts';
import { selectElements } from './dedupe.ts';
import type { FoundElement, NewPanel } from './page.ts';
import { displayPath } from './rules.ts';

const execFileAsync = promisify(execFile);

/** Record and media ids: 16 lowercase alphanumerics (~83 bits), safe in record ids and file names. */
export const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

// --- browser ---------------------------------------------------------------------------------

/** Device pixel ratio for every capture. Crops are taken from the full-page image at this scale. */
const DEVICE_SCALE_FACTOR = 2;
/** Mobile is Playwright's iPhone 15 Pro viewport. */
export const VIEWPORT_SIZES: Record<Viewport, { width: number; height: number }> = {
	desktop: { width: 1440, height: 900 },
	mobile: { width: 393, height: 659 }
};
const PAGE_TIMEOUT_MS = 30_000;

/** Analytics, ads, session replay and chat widgets: slow, irrelevant, and they pollute screenshots. */
const BLOCKED_HOSTS = [
	'google-analytics.com',
	'googletagmanager.com',
	'googleadservices.com',
	'doubleclick.net',
	'googlesyndication.com',
	'facebook.net',
	'connect.facebook.com',
	'hotjar.com',
	'hotjar.io',
	'segment.com',
	'segment.io',
	'mixpanel.com',
	'amplitude.com',
	'fullstory.com',
	'clarity.ms',
	'heapanalytics.com',
	'logrocket.com',
	'sentry.io',
	'intercom.io',
	'intercomcdn.com',
	'drift.com',
	'driftt.com',
	'crisp.chat',
	'tawk.to',
	'hs-analytics.net',
	'hsadspixel.net',
	'adsrvr.org',
	'taboola.com',
	'outbrain.com',
	'ads-twitter.com',
	'analytics.tiktok.com',
	'snap.licdn.com',
	'px.ads.linkedin.com'
];

export interface BrowserSession {
	browser: Browser;
	context: BrowserContext;
	userAgent: string;
}

let pageInspectorBundle: Promise<string> | undefined;

/**
 * `page.ts` bundled into one script with `bun build`. Bundling lets the in-page code use normal
 * imports and constants, instead of having to be a single self-contained function.
 */
function pageInspectorScript(): Promise<string> {
	if (pageInspectorBundle === undefined) {
		const entry = fileURLToPath(new URL('./page.ts', import.meta.url));
		pageInspectorBundle = execFileAsync(
			process.execPath,
			['build', entry, '--target', 'browser', '--format', 'iife'],
			{
				maxBuffer: 10 * 1024 * 1024
			}
		).then((result) => result.stdout);
	}
	return pageInspectorBundle;
}

/** One browser per crawl, with one context so cookies (e.g. a dismissed banner) persist across pages. */
export async function openBrowser(viewport: Viewport): Promise<BrowserSession> {
	const browser = await chromium.launch({
		headless: true,
		// The worker handles SIGINT/SIGTERM itself so it can requeue the crawl before exiting;
		// Playwright's own handlers would kill the browser mid-crawl and exit the process.
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
		args: [
			// Headless Chrome announces itself in navigator.webdriver, which some sites answer with a bot wall.
			'--disable-blink-features=AutomationControlled',
			// Classic scrollbars would take 15px off the layout width and show up in screenshots.
			'--hide-scrollbars'
		]
	});
	const chromeMajorVersion = browser.version().split('.')[0];

	let userAgent: string;
	let contextOptions: Parameters<Browser['newContext']>[0];
	if (viewport === 'mobile') {
		// Chrome on iOS. The iPhone profile is meant for WebKit, so keep its viewport and touch
		// settings but drop `defaultBrowserType`, and use a Chrome user agent since we run chromium.
		userAgent = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${chromeMajorVersion}.0.0.0 Mobile/15E148 Safari/604.1`;
		const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 15 Pro'];
		contextOptions = { ...iphone, deviceScaleFactor: DEVICE_SCALE_FACTOR, userAgent };
	} else {
		userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajorVersion}.0.0.0 Safari/537.36`;
		contextOptions = {
			viewport: VIEWPORT_SIZES.desktop,
			deviceScaleFactor: DEVICE_SCALE_FACTOR,
			userAgent
		};
	}

	// Service workers would bypass the request blocking below.
	const context = await browser.newContext({ ...contextOptions, serviceWorkers: 'block' });
	context.setDefaultTimeout(PAGE_TIMEOUT_MS);
	await context.addInitScript({ content: await pageInspectorScript() });
	await context.route('**/*', (route) => {
		const request = route.request();
		const { hostname } = new URL(request.url());
		const isBlockedHost = BLOCKED_HOSTS.some(
			(blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`)
		);
		// Video is heavy and never visible in a still screenshot anyway.
		if (request.resourceType() === 'media' || isBlockedHost) return route.abort();
		return route.continue();
	});
	return { browser, context, userAgent };
}

const BROWSER_CLOSE_TIMEOUT_MS = 10_000;

/**
 * Closes the browser without waiting forever. Closing takes milliseconds, but under Bun the close
 * promise has been seen to never settle after the chrome process had already exited, and a hung
 * close would leave the crawl (and the worker) stuck in 'running'.
 */
export async function closeBrowser(browser: Browser): Promise<void> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<void>((resolve) => {
		timeoutHandle = setTimeout(() => {
			console.warn('  browser did not close in time, moving on');
			resolve();
		}, BROWSER_CLOSE_TIMEOUT_MS);
	});
	try {
		await Promise.race([browser.close(), timedOut]);
	} finally {
		clearTimeout(timeoutHandle);
	}
}

// --- cookie banner ---------------------------------------------------------------------------

/** Accept buttons of the common consent managers, which have stable selectors. */
const KNOWN_ACCEPT_BUTTONS = [
	'#onetrust-accept-btn-handler', // OneTrust
	'#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', // Cookiebot
	'#CybotCookiebotDialogBodyButtonAccept', // Cookiebot (older banner)
	'#truste-consent-button', // TrustArc
	'#didomi-notice-agree-button', // Didomi
	'.fc-cta-consent', // Google Funding Choices
	'.cc-allow, .cc-accept', // Cookie Consent by Osano
	'button[data-cookiefirst-action="accept"]', // CookieFirst
	'button[data-testid="uc-accept-all-button"]' // Usercentrics
].join(', ');

/** Anything whose id, class or label says it is a cookie/consent/privacy banner. */
const COOKIE_BANNER = ['cookie', 'consent', 'gdpr', 'privacy']
	.flatMap((word) => [`[id*="${word}" i]`, `[class*="${word}" i]`, `[aria-label*="${word}" i]`])
	.join(', ');

/** Button names that accept everything. "Reject", "Manage" and "Settings" must not match. */
const ACCEPT_LABEL =
	/^(accept( all)?( cookies)?( (&|and) close)?|i accept|i agree|agree( and (close|continue))?|allow all( cookies)?|allow cookies|allow|got it|ok|okay|alle akzeptieren|akzeptieren|zustimmen|einverstanden)$/i;

/** Consent managers that render in an iframe usually give it away in the iframe URL. */
const CONSENT_IFRAME_URL =
	/consent|cookie|privacy|gdpr|cmp|sp_message|onetrust|trustarc|usercentrics|didomi/i;

/** How long a banner may take to appear after load, on the first page only. */
const BANNER_APPEAR_TIMEOUT_MS = 3000;
const BANNER_POLL_INTERVAL_MS = 250;
const BANNER_CLICK_TIMEOUT_MS = 2000;
const BANNER_EXIT_TIMEOUT_MS = 3000;

/**
 * A frame can be detached or navigated away while we ask about it (consent iframes do this right
 * after being accepted). That is not an error here, the banner is simply gone.
 */
async function isVisibleIfAttached(locator: Locator): Promise<boolean> {
	try {
		return await locator.isVisible();
	} catch (error) {
		if (error instanceof Error && /detached|destroyed|closed/i.test(error.message)) return false;
		throw error;
	}
}

/** The "accept all" button of a visible cookie banner, in the page or in any of its iframes. */
async function findAcceptButton(page: Page): Promise<Locator | undefined> {
	for (const frame of page.frames()) {
		const acceptButton = acceptButtonLocator(frame, frame === page.mainFrame()).first();
		if (await isVisibleIfAttached(acceptButton)) return acceptButton;
	}
	return undefined;
}

function acceptButtonLocator(frame: Frame, isMainFrame: boolean): Locator {
	const knownButton = frame.locator(KNOWN_ACCEPT_BUTTONS);
	// In the page itself the button has to sit inside something that calls itself a cookie banner,
	// or any "OK" button would match. A consent iframe's whole document is the banner.
	if (isMainFrame)
		return knownButton.or(frame.locator(COOKIE_BANNER).getByRole('button', { name: ACCEPT_LABEL }));
	if (CONSENT_IFRAME_URL.test(frame.url()))
		return knownButton.or(frame.getByRole('button', { name: ACCEPT_LABEL }));
	return knownButton;
}

/**
 * Cookie banners cover part of every screenshot, so we accept them. Looks for the buttons of
 * common consent managers, or an "accept" button inside something that looks like a cookie banner,
 * in every frame (some banners are iframes). Returns whether a banner was dismissed.
 *
 * Banners are often injected after load. On the first page of a crawl, pass `waitForBanner` to give
 * one time to appear; later pages have the consent cookie, so a banner is there right away or not at all.
 */
export async function acceptCookieBanner(
	page: Page,
	options: { waitForBanner: boolean }
): Promise<boolean> {
	const deadline = Date.now() + (options.waitForBanner ? BANNER_APPEAR_TIMEOUT_MS : 0);
	while (true) {
		const acceptButton = await findAcceptButton(page);
		if (acceptButton) return await clickUntilGone(acceptButton);
		if (Date.now() >= deadline) return false;
		await page.waitForTimeout(BANNER_POLL_INTERVAL_MS);
	}
}

/** Clicks the button and waits for the banner to leave, so its exit animation isn't in the screenshot. */
async function clickUntilGone(acceptButton: Locator): Promise<boolean> {
	try {
		await acceptButton.click({ timeout: BANNER_CLICK_TIMEOUT_MS });
		await acceptButton.waitFor({ state: 'hidden', timeout: BANNER_EXIT_TIMEOUT_MS });
		return true;
	} catch (error) {
		// Covered by another overlay, or the banner stays after the click. Carry on without it.
		if (error instanceof errors.TimeoutError) return false;
		throw error;
	}
}

// --- loading a page --------------------------------------------------------------------------

/** Many sites never reach network idle (polling, websockets), so waiting for it is capped. */
const NETWORK_IDLE_CAP_MS = 5000;
/** Late layout shifts and entrance animations get this long to finish once fonts are ready. */
const FINAL_SETTLE_MS = 400;
/** Scrolling 25 viewports covers ~22000px, enough to trigger lazy loading on any normal page. */
const MAX_SCROLL_STEPS = 25;

/**
 * Loads a URL and brings it to a stable state: DOM ready, network (mostly) idle, cookie banner
 * gone, lazy content loaded by scrolling through the page, fonts ready, scrolled back to the top.
 * Returns the main-document response.
 */
export async function loadPage(
	page: Page,
	url: string,
	options: { waitForBanner: boolean }
): Promise<Response | null> {
	const response = await page.goto(url, {
		waitUntil: 'domcontentloaded',
		timeout: PAGE_TIMEOUT_MS
	});
	try {
		await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_CAP_MS });
	} catch (error) {
		if (!(error instanceof errors.TimeoutError)) throw error;
	}
	await acceptCookieBanner(page, options);

	const { height: stepHeight } = page.viewportSize() ?? VIEWPORT_SIZES.desktop;
	await page.evaluate(([step, maxSteps]) => window.pageInspector!.scrollThrough(step, maxSteps), [
		stepHeight,
		MAX_SCROLL_STEPS
	] as const);
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(FINAL_SETTLE_MS);
	return response;
}

// --- images ----------------------------------------------------------------------------------

const WEBP_QUALITY = 82;
const THUMB_WIDTH = 720;
/** Padding around an element when cropping it from the full-page image, in CSS px. */
const CROP_PADDING = 8;
/** Full-page screenshots are capped at this many CSS px of height (webp maxes out at 16383 px). */
const MAX_FULL_HEIGHT = 8000;

const SCREENSHOT_OPTIONS = { type: 'png', animations: 'disabled', caret: 'hide' } as const;

export function viewportScreenshot(page: Page): Promise<Buffer> {
	return page.screenshot(SCREENSHOT_OPTIONS);
}

/**
 * 64-bit difference hash (hex): shrink to 9x8 grayscale and compare each pixel with its right
 * neighbour. Robust to small rendering noise, so near-identical screens hash within a few bits.
 */
export async function dHash(image: Uint8Array): Promise<string> {
	const pixels = await sharp(image).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
	let bits = 0n;
	for (let row = 0; row < 8; row++) {
		for (let column = 0; column < 8; column++) {
			const isBrighterToTheRight = pixels[row * 9 + column] < pixels[row * 9 + column + 1];
			bits = (bits << 1n) | (isBrighterToTheRight ? 1n : 0n);
		}
	}
	return bits.toString(16).padStart(16, '0');
}

/** Number of differing bits between two dHashes. */
export function hammingDistance(hashA: string, hashB: string): number {
	let differingBits = BigInt('0x' + hashA) ^ BigInt('0x' + hashB);
	let count = 0;
	while (differingBits) {
		count += Number(differingBits & 1n);
		differingBits >>= 1n;
	}
	return count;
}

/** sha1 of the page's structural skeleton (see `domSkeleton` in page.ts). */
export async function computeDomSig(page: Page): Promise<string> {
	const skeleton = await page.evaluate(() => window.pageInspector!.domSkeleton());
	return createHash('sha1').update(skeleton).digest('hex');
}

// --- capturing a screen ----------------------------------------------------------------------

export interface CaptureRequest {
	page: Page;
	ctx: CrawlContext;
	kind: 'page' | 'state';
	/** URL of the page; for a state this is still the page it was opened on. */
	url: string;
	depth: number;
	domSig: string;
	/** For states: the elements of the page underneath, and what the click revealed. */
	baseline?: FoundElement[];
	newPanels?: NewPanel[];
}

export interface CapturedScreen {
	id: string;
	/** dHash of the viewport image. */
	imageHash: string;
	/** Height of the full-page image in CSS px. */
	fullHeight: number;
	/** Every element found on the page, before filtering: a state's baseline. */
	foundElements: FoundElement[];
}

/**
 * Takes the viewport and full-page screenshots of the page as it is now, stores them with a
 * `screen` record, and crops and stores the page's elements.
 */
export async function captureScreen(request: CaptureRequest): Promise<CapturedScreen> {
	const { page, ctx } = request;
	const { width, height } = VIEWPORT_SIZES[ctx.job.viewport];
	const screenId = newId();
	const keyPrefix = `sites/${ctx.siteId}/${ctx.job.viewport}/${screenId}`;

	const title = await page.title();
	const found = await page.evaluate(() => window.pageInspector!.findElements());
	const viewportPng = await viewportScreenshot(page);
	// Taller pages are cut off at the cap with a clip, because webp can't encode huge images.
	const clip =
		found.pageHeight > MAX_FULL_HEIGHT ? { x: 0, y: 0, width, height: MAX_FULL_HEIGHT } : undefined;
	const fullPng = await page.screenshot({ ...SCREENSHOT_OPTIONS, fullPage: true, clip });

	const [viewportWebp, fullWebp, thumbWebp, fullMetadata, imageHash] = await Promise.all([
		sharp(viewportPng).webp({ quality: WEBP_QUALITY }).toBuffer(),
		sharp(fullPng).webp({ quality: WEBP_QUALITY }).toBuffer(),
		sharp(viewportPng)
			.resize({ width: THUMB_WIDTH, withoutEnlargement: true })
			.webp({ quality: WEBP_QUALITY })
			.toBuffer(),
		sharp(fullPng).metadata(),
		dHash(viewportPng)
	]);
	// Measured from the image rather than the DOM: the page may overflow sideways, or be capped.
	const fullWidth = Math.round((fullMetadata.width ?? 0) / DEVICE_SCALE_FACTOR);
	const fullHeight = Math.round((fullMetadata.height ?? 0) / DEVICE_SCALE_FACTOR);

	const media = {
		viewport: `${keyPrefix}/viewport.webp`,
		full: `${keyPrefix}/full.webp`,
		thumb: `${keyPrefix}/thumb.webp`
	};
	await Promise.all([
		ctx.media.put(media.viewport, viewportWebp),
		ctx.media.put(media.full, fullWebp),
		ctx.media.put(media.thumb, thumbWebp)
	]);

	const screenRecord = new RecordId('screen', screenId);
	await ctx.db
		.query('CREATE ONLY $id CONTENT $content', {
			id: screenRecord,
			content: {
				site: ctx.job.site,
				crawl: ctx.job.id,
				viewport: ctx.job.viewport,
				kind: request.kind,
				url: request.url,
				path: displayPath(request.url),
				title,
				depth: request.depth,
				seq: ctx.nextSeq++,
				width,
				height,
				full_height: fullHeight,
				media,
				dom_sig: request.domSig,
				image_hash: imageHash
			}
		})
		.collect();
	ctx.screens++;

	const selected = selectElements({
		found: found.elements,
		imageWidth: fullWidth,
		imageHeight: fullHeight,
		viewport: ctx.job.viewport,
		knownButtons: ctx.knownButtons,
		baseline: request.baseline,
		newPanels: request.newPanels
	});
	await storeElements(ctx, screenRecord, keyPrefix, fullPng, selected);
	await ctx.saveProgress();

	return { id: screenId, imageHash, fullHeight, foundElements: found.elements };
}

/** Crops each element (plus padding) out of the full-page image, and saves the crop with its record. */
async function storeElements(
	ctx: CrawlContext,
	screen: RecordId,
	keyPrefix: string,
	fullPng: Buffer,
	elements: { kind: ElementKind; name: string; rect: Rect }[]
): Promise<void> {
	if (elements.length === 0) return;
	// Decoded once: cropping from the PNG directly would decode the whole page for every element.
	const { data, info } = await sharp(fullPng).raw().toBuffer({ resolveWithObject: true });

	for (const element of elements) {
		const { x, y, w, h } = element.rect;
		const left = Math.max(0, Math.floor((x - CROP_PADDING) * DEVICE_SCALE_FACTOR));
		const top = Math.max(0, Math.floor((y - CROP_PADDING) * DEVICE_SCALE_FACTOR));
		const right = Math.min(info.width, Math.ceil((x + w + CROP_PADDING) * DEVICE_SCALE_FACTOR));
		const bottom = Math.min(info.height, Math.ceil((y + h + CROP_PADDING) * DEVICE_SCALE_FACTOR));
		const crop = await sharp(data, {
			raw: { width: info.width, height: info.height, channels: info.channels }
		})
			.extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
			.webp({ quality: WEBP_QUALITY })
			.toBuffer();

		const elementId = newId();
		const key = `${keyPrefix}/el/${elementId}.webp`;
		await ctx.media.put(key, crop);
		await ctx.db
			.query('CREATE ONLY $id CONTENT $content', {
				id: new RecordId('element', elementId),
				content: {
					site: ctx.job.site,
					screen,
					viewport: ctx.job.viewport,
					kind: element.kind,
					name: element.name,
					rect: element.rect,
					media: key
				}
			})
			.collect();
		ctx.elements++;
	}
}
