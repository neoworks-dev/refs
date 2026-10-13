// What the link rules are for: visiting the pages that show the most of a site first, and
// recognising addresses that are the same page.
import { describe, expect, test } from 'bun:test';
import { isDestructive, normalizeUrl, scoreLink, urlKey } from '../crawler/rules.ts';

describe('link scoring', () => {
	test('navigation links are visited before body links, and footer links last', () => {
		const url = 'https://example.com/company';

		const nav = scoreLink(url, 1, 'nav');
		const main = scoreLink(url, 1, 'main');
		const other = scoreLink(url, 1, 'other');
		const footer = scoreLink(url, 1, 'footer');

		expect([nav, main, other, footer].sort((a, b) => b - a)).toEqual([nav, main, other, footer]);
		expect(nav).toBeGreaterThan(main);
		expect(main).toBeGreaterThan(footer);
	});

	test('pages named like the places a design library wants come first', () => {
		const pricing = scoreLink('https://example.com/pricing', 1, 'main');
		const plain = scoreLink('https://example.com/lorem', 1, 'main');

		expect(pricing).toBeGreaterThan(plain);
	});

	test('shallow pages beat deep ones, and short paths beat long article slugs', () => {
		const shallow = scoreLink('https://example.com/about', 1, 'main');
		const deeper = scoreLink('https://example.com/about', 3, 'main');
		const article = scoreLink(
			'https://example.com/blog/2026/10/how-we-rebuilt-our-design-system',
			1,
			'main'
		);
		const section = scoreLink('https://example.com/blog', 1, 'main');

		expect(shallow).toBeGreaterThan(deeper);
		expect(section).toBeGreaterThan(article);
	});

	test('a link with a query string scores below the same page without one', () => {
		const clean = scoreLink('https://example.com/docs', 1, 'main');
		const filtered = scoreLink('https://example.com/docs?page=2', 1, 'main');

		expect(clean).toBeGreaterThan(filtered);
	});

	test('the order across a whole page of links is nav, then content, then footer', () => {
		const links = [
			{ url: 'https://example.com/legal/privacy-policy', region: 'footer' as const },
			{ url: 'https://example.com/blog/2026/how-we-built-it', region: 'main' as const },
			{ url: 'https://example.com/pricing', region: 'nav' as const },
			{ url: 'https://example.com/customers', region: 'main' as const }
		];

		const ordered = links
			.map((link) => ({ ...link, score: scoreLink(link.url, 1, link.region) }))
			.sort((first, second) => second.score - first.score)
			.map((link) => new URL(link.url).pathname);

		expect(ordered).toEqual([
			'/pricing',
			'/customers',
			'/blog/2026/how-we-built-it',
			'/legal/privacy-policy'
		]);
	});
});

describe('destructive controls', () => {
	test('names that destroy data or commit to something are never clicked', () => {
		for (const label of [
			'Delete account',
			'Sign out',
			'Log out',
			'Buy now',
			'Place order',
			'Confirm'
		]) {
			expect(isDestructive(label)).toBe(true);
		}
	});

	test('ordinary menu triggers are fine', () => {
		for (const label of ['Products', 'Resources', 'Pricing', 'Menu', 'Learn more']) {
			expect(isDestructive(label)).toBe(false);
		}
	});
});

describe('url identity', () => {
	test('tracking parameters, hashes and trailing slashes do not make a new page', () => {
		const first = normalizeUrl('https://www.example.com/pricing/?utm_source=x#plans');
		const second = normalizeUrl('https://example.com/pricing');

		expect(urlKey(first!)).toBe(urlKey(second!));
	});
});
