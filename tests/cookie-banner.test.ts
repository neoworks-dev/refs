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
