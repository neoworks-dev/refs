// How a replay decides that the control at a recorded place is the one the crawler clicked, and
// when two URLs are the same page.
import { describe, expect, test } from 'bun:test';
import { controlMatches, sameLocation } from '../crawler/videos.ts';

const target = { url: 'https://example.com/pricing' };

describe('controlMatches', () => {
	test('a label matches loosely, since the crawler stored link text and the page has an accessible name', () => {
		expect(
			controlMatches({ name: 'Pricing' }, { kind: 'navigate', label: ' pricing ' }, target)
		).toBe(true);
		expect(
			controlMatches(
				{ name: 'Contact sales and get a quote' },
				{ kind: 'navigate', label: 'Contact sales…' },
				target
			)
		).toBe(true);
	});

	test('another control at the same place does not match', () => {
		expect(
			controlMatches({ name: 'Sign in' }, { kind: 'navigate', label: 'Pricing' }, target)
		).toBe(false);
	});

	test('a control without a name never matches a labelled action', () => {
		expect(controlMatches({ name: '' }, { kind: 'click', label: 'Menu' }, target)).toBe(false);
	});

	test('an unlabelled link has to point at the screen the action led to', () => {
		const action = { kind: 'navigate', label: '' } as const;
		expect(
			controlMatches({ name: 'x', href: 'https://example.com/pricing/' }, action, target)
		).toBe(true);
		expect(controlMatches({ name: 'x', href: 'https://example.com/about' }, action, target)).toBe(
			false
		);
		expect(controlMatches({ name: 'x' }, action, target)).toBe(false);
	});

	test('an unlabelled click cannot be checked, so it is accepted', () => {
		expect(controlMatches({ name: 'x' }, { kind: 'click', label: '' }, target)).toBe(true);
	});
});

describe('sameLocation', () => {
	test('ignores trailing slashes, fragments, www and tracking parameters', () => {
		expect(sameLocation('https://www.example.com/a/', 'https://example.com/a#top')).toBe(true);
		expect(sameLocation('https://example.com/a?utm_source=x', 'https://example.com/a')).toBe(true);
	});

	test('tells different paths and queries apart', () => {
		expect(sameLocation('https://example.com/a', 'https://example.com/b')).toBe(false);
		expect(sameLocation('https://example.com/a?page=2', 'https://example.com/a')).toBe(false);
	});
});
