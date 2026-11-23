// What `acceptCookieBanner` is for: dismissing the consent notice that would otherwise cover a
// screenshot, while never pressing an "Accept" button that belongs to the page.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import {
	acceptCookieBanner,
	closeBrowser,
	openBrowser,
	type BrowserSession
} from '../crawler/capture.ts';
import { fixtureUrl } from './support.ts';

let session: BrowserSession;
beforeAll(async () => {
	session = await openBrowser('desktop');
});
afterAll(() => closeBrowser(session.browser));

async function openFixture(name: string): Promise<Page> {
	const page = await session.context.newPage();
	await page.goto(fixtureUrl(name));
	return page;
}

describe('known consent managers', () => {
	test('a OneTrust banner is accepted, not rejected, and the page keeps its own "Accept" button', async () => {
		const page = await openFixture('onetrust-banner.html');

		expect(await acceptCookieBanner(page, { waitForBanner: false })).toBe(true);

		expect(await page.locator('#onetrust-banner-sdk').count()).toBe(0);
		expect(await page.evaluate(() => (window as any).rejected)).toBeUndefined();
		expect(await page.evaluate(() => (window as any).invitationAccepted)).toBeUndefined();
	});
});

describe('pages without a banner', () => {
	test('an iframe that has not loaded yet is skipped instead of waited on forever', async () => {
		const page = await openFixture('lazy-iframe.html');
		expect(page.frames().some((frame) => frame.url() === '')).toBe(true);

		expect(await acceptCookieBanner(page, { waitForBanner: false })).toBe(false);
	});
});

describe('banners the markup does not give away', () => {
	test('a banner inside a consent iframe is accepted through its frame', async () => {
		const page = await openFixture('consent-iframe-banner.html');

		expect(await acceptCookieBanner(page, { waitForBanner: false })).toBe(true);

		expect(await page.locator('#banner').count()).toBe(0);
	});

	test('a floating notice with no cookie ids is accepted once it appears, and the page content is left alone', async () => {
		const page = await openFixture('floating-notice.html');
		// Not there yet: the fixture injects it a second after load.
		expect(await acceptCookieBanner(page, { waitForBanner: false })).toBe(false);

		expect(await acceptCookieBanner(page, { waitForBanner: true })).toBe(true);

		expect(await page.locator('.notice').count()).toBe(0);
		// The "Accept" in the page's own section is an invitation, not consent.
		expect(await page.evaluate(() => (window as any).invitationAccepted)).toBeUndefined();
	});

	test('a fixed bar with an "Accept" button that is not about consent is not clicked', async () => {
		const page = await openFixture('floating-unrelated.html');

		expect(await acceptCookieBanner(page, { waitForBanner: false })).toBe(false);

		expect(await page.evaluate(() => (window as any).invitationAccepted)).toBeUndefined();
	});
});

describe('banners in a shadow root', () => {
	test('a Usercentrics style host is accepted even without data-testid attributes', async () => {
		const page = await openFixture('shadow-root-banner.html');

		expect(await acceptCookieBanner(page, { waitForBanner: false })).toBe(true);

		expect(await page.locator('#usercentrics-root .dialog').count()).toBe(0);
	});

	test('an unnamed floating notice in a shadow root is recognised by its text', async () => {
		const page = await openFixture('shadow-root-floating-notice.html');

		expect(await acceptCookieBanner(page, { waitForBanner: false })).toBe(true);

		expect(await page.locator('#widget-host .notice').count()).toBe(0);
	});
});

describe('banners that cannot be accepted', () => {
	test('a consent wall with only "reject" and "settings" is hidden with its backdrop, the scroll lock is undone and the page is left alone', async () => {
		const page = await openFixture('consent-settings-only.html');

		expect(await acceptCookieBanner(page, { waitForBanner: false })).toBe(false);
		expect(await page.evaluate(() => window.pageInspector!.hasConsentBanner())).toBe(true);
		expect(await page.evaluate(() => window.pageInspector!.removeConsentBanners())).toBe(1);

		expect(await page.locator('.wall').isVisible()).toBe(false);
		expect(await page.locator('.backdrop').isVisible()).toBe(false);
		await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'instant' }));
		expect(await page.evaluate(() => window.scrollY)).toBe(300);
		// The page's own privacy section and its fixed footer are content.
		expect(await page.locator('.privacy-section').isVisible()).toBe(true);
		expect(await page.locator('.footer').isVisible()).toBe(true);
		expect(await page.evaluate(() => window.pageInspector!.hasConsentBanner())).toBe(false);
	});

	test('a banner in a shadow root that shows up late is hidden by the guard, and the position lock on the body is undone', async () => {
		const page = await openFixture('consent-late-locked.html');
		await page.evaluate(() => window.pageInspector!.keepConsentBannersHidden());

		await page.waitForFunction(() => document.getElementById('consent-host') !== null);
		await page.waitForFunction(() => getComputedStyle(document.body).position === 'static');

		expect(await page.evaluate(() => window.pageInspector!.hasConsentBanner())).toBe(false);
		await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'instant' }));
		expect(await page.evaluate(() => window.scrollY)).toBe(300);
	});

	test('a sign-up dialog or a policy notice that mentions privacy is not a consent banner', async () => {
		const page = await openFixture('signup-dialog.html');

		expect(await page.evaluate(() => window.pageInspector!.hasConsentBanner())).toBe(false);
		expect(await page.evaluate(() => window.pageInspector!.removeConsentBanners())).toBe(0);

		expect(await page.locator('#signup').isVisible()).toBe(true);
		expect(await page.locator('#terms').isVisible()).toBe(true);
	});
});
