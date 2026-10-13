// What the in-page extraction (`findElements`, `clickTargets`) is for: finding the sections,
// buttons and menu triggers of a page, whatever markup the site's framework wraps them in.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeBrowser, loadPage, openBrowser, type BrowserSession } from '../crawler/capture.ts';
import { chooseClickTargets } from '../crawler/rules.ts';
import { fixtureUrl } from './support.ts';

let session: BrowserSession;
beforeAll(async () => {
	session = await openBrowser('desktop');
});
afterAll(() => closeBrowser(session.browser));

async function loadFixture(name: string) {
	const page = await session.context.newPage();
	await loadPage(page, fixtureUrl(name), { waitForBanner: false });
	return page;
}

describe('section detection', () => {
	test('sections are found inside a page wrapped in several single-child divs', async () => {
		const page = await loadFixture('wrapped-sections.html');

		const { elements } = await page.evaluate(() => window.pageInspector!.findElements());

		const sections = elements.filter((element) => element.kind === 'section');
		// Not one 1200px block for the whole page: the wrappers are looked through to the real sections.
		expect(sections.map((section) => section.name)).toEqual(['Hero', 'Features', 'Pricing']);
		expect(sections.map((section) => section.rect.h)).toEqual([400, 400, 400]);
	});
});

describe('button detection', () => {
	test('links dressed as buttons are buttons, and links in text or cards are not', async () => {
		const page = await loadFixture('buttons.html');

		const { elements } = await page.evaluate(() => window.pageInspector!.findElements());

		const buttonNames = elements.filter((element) => element.kind === 'button').map((e) => e.name);
		// A filled link and an outlined link are call-to-action buttons, next to a real <button>.
		expect(buttonNames).toContain('Get started');
		expect(buttonNames).toContain('Book a demo');
		expect(buttonNames).toContain('Subscribe');
		// Inline text links have no fill, border or padding. The card is a link, but far taller than a button.
		expect(buttonNames).not.toContain('documentation');
		expect(buttonNames).not.toContain('see pricing');
		expect(buttonNames.some((name) => name.startsWith('A clickable card'))).toBe(false);
		// Native buttons under 24x20px are icon fragments or hit targets.
		expect(buttonNames).not.toContain('Dot');
	});

	test('links dressed as buttons are marked as looking like buttons, so they are cropped first', async () => {
		const page = await loadFixture('buttons.html');

		const { elements } = await page.evaluate(() => window.pageInspector!.findElements());

		const getStarted = elements.find((element) => element.name === 'Get started');
		expect(getStarted?.looksLikeButton).toBe(true);
	});
});

describe('click candidates', () => {
	test('a destructive control that opens a menu is offered by the page but never chosen to click', async () => {
		const page = await loadFixture('destructive-controls.html');

		const targets = await page.evaluate(() => window.pageInspector!.clickTargets());
		const chosen = chooseClickTargets(targets, 10).map((target) => target.name);

		// The page extraction cannot tell harmless from harmful; the crawler's rules decide.
		expect(targets.map((target) => target.name)).toContain('Delete account');
		expect(chosen).toEqual(['Products', 'Resources']);
	});

	test('a click target records which part of the page it sits in', async () => {
		const page = await loadFixture('destructive-controls.html');

		const targets = await page.evaluate(() => window.pageInspector!.clickTargets());

		// Stored on the action, so flows can tell main navigation clicks from clicks in the content.
		expect(targets.find((target) => target.name === 'Products')?.region).toBe('nav');
	});

	test('form submit buttons are not click targets at all', async () => {
		const page = await loadFixture('destructive-controls.html');

		const targets = await page.evaluate(() => window.pageInspector!.clickTargets());

		expect(targets.map((target) => target.name)).not.toContain('Save changes');
	});
});
