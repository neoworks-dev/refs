// What `loadPage` and the capture preparation are for: a page that looks the way a visitor sees
// it, without things that only appear because a crawler is looking.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import {
	closeBrowser,
	isBlankImage,
	loadPage,
	openBrowser,
	type BrowserSession
} from '../crawler/capture.ts';
import { fixtureUrl } from './support.ts';

let session: BrowserSession;
beforeAll(async () => {
	session = await openBrowser('desktop');
});
afterAll(() => closeBrowser(session.browser));

describe('content that renders late', () => {
	test('sections the browser skips until scrolled near are painted in a full-page screenshot', async () => {
		const page = await session.context.newPage();
		await loadPage(page, fixtureUrl('lazy-sections.html'), { waitForBanner: false });

		const fullPage = await page.screenshot({ fullPage: true, animations: 'disabled' });

		// The dark heading of the last section starts 2400 CSS px down. Unpainted, it is the page background.
		// `stats()` ignores pending operations, so the crop is encoded before it is measured.
		const lastHeading = await sharp(fullPage)
			.extract({ left: 0, top: 2400 * 2, width: 2880, height: 160 })
			.png()
			.toBuffer();
		expect(await isBlankImage(sharp(lastHeading))).toBe(false);
	});

	test('elements revealed by scrolling have finished fading in when the page is ready', async () => {
		const page = await session.context.newPage();
		await loadPage(page, fixtureUrl('reveal-on-scroll.html'), { waitForBanner: false });

		const opacity = await page
			.locator('#late')
			.evaluate((element) => getComputedStyle(element).opacity);

		expect(opacity).toBe('1');
	});
});

describe('blank crops', () => {
	test('an image of one colour is blank, and one with content is not', async () => {
		const flat = sharp({ create: { width: 200, height: 100, channels: 3, background: '#0a0a0c' } });
		const withText = sharp({
			create: { width: 200, height: 100, channels: 3, background: '#0a0a0c' }
		}).composite([
			{
				input: { create: { width: 60, height: 12, channels: 3, background: '#888' } },
				left: 20,
				top: 40
			}
		]);

		expect(await isBlankImage(flat)).toBe(true);
		expect(await isBlankImage(sharp(await withText.png().toBuffer()))).toBe(false);
	});
});

describe('chat launchers', () => {
	async function loadChatFixture(name: string, viewport: 'desktop' | 'mobile' = 'desktop') {
		const page = await session.context.newPage();
		await page.setViewportSize(
			viewport === 'desktop' ? { width: 1440, height: 900 } : { width: 393, height: 659 }
		);
		await loadPage(page, fixtureUrl(name), { waitForBanner: false });
		const hidden = await page.evaluate(() => window.pageInspector!.hideChatLaunchers());
		return { page, hidden };
	}

	test('a first-party chat teaser and the launcher button inside it are hidden together', async () => {
		const { page } = await loadChatFixture('chat-launchers.html');

		expect(await page.locator('#teaser').isVisible()).toBe(false);
		expect(await page.locator('#chat-button').isVisible()).toBe(false);
	});

	test('a round bubble that is only labelled "Open chat" is hidden', async () => {
		const { page } = await loadChatFixture('chat-launchers.html');

		expect(await page.locator('#bubble').isVisible()).toBe(false);
	});

	test('page content that mentions help or support stays, even a fixed bar', async () => {
		const { page } = await loadChatFixture('chat-launchers.html');

		expect(await page.locator('#help-nav').isVisible()).toBe(true);
		expect(await page.getByRole('link', { name: 'Contact support' }).isVisible()).toBe(true);
		// Fixed in the bottom corner and mentions "help", but it is a wide bar, not a bubble.
		expect(await page.locator('#cookie-bar').isVisible()).toBe(true);
	});

	test('a "Help" entry in a mobile tab bar is navigation and stays', async () => {
		const { page, hidden } = await loadChatFixture('chat-launchers-mobile-tabbar.html', 'mobile');

		expect(hidden).toBe(0);
		expect(await page.getByRole('link', { name: 'Help' }).isVisible()).toBe(true);
	});
});
