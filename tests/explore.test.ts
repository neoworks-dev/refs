// What goal-directed exploration decides without a browser: which goals are worth running and in
// what order, and which actions it refuses to carry out.
import { describe, expect, test } from 'bun:test';
import { refusalReason } from '../crawler/agent.ts';
import { selectDistinctGoals, type PlannedGoal } from '../crawler/goals.ts';

const rect = { x: 0, y: 0, w: 10, h: 10 };

/** A goal whose embedding is a unit vector pointing at `angle` degrees, so cosines are easy to read. */
function goal(
	text: string,
	options: { angle: number; category?: string; startPath?: string; actions?: number }
): PlannedGoal {
	const radians = (options.angle * Math.PI) / 180;
	return {
		goal: text,
		category: options.category ?? 'other',
		startPath: options.startPath ?? '/',
		success: '',
		actions: options.actions ?? 2,
		embedding: [Math.cos(radians), Math.sin(radians)]
	};
}

describe('choosing goals', () => {
	test('a reworded goal is dropped, and the longer of the two is kept', () => {
		const short = goal('Open pricing', { angle: 0, actions: 1 });
		const long = goal('Compare the plans on the pricing page', { angle: 10, actions: 3 });

		const chosen = selectDistinctGoals([short, long]);

		expect(chosen.map((kept) => kept.goal)).toEqual([long.goal]);
	});

	test('goals that differ all stay', () => {
		const chosen = selectDistinctGoals([
			goal('Compare plans', { angle: 0 }),
			goal('Search the docs', { angle: 90 })
		]);

		expect(chosen).toHaveLength(2);
	});

	test('the order spreads over categories and start pages before going deep on one', () => {
		const chosen = selectDistinctGoals([
			goal('Pricing one', { angle: 0, category: 'pricing_and_plans', startPath: '/pricing' }),
			goal('Pricing two', { angle: 60, category: 'pricing_and_plans', startPath: '/pricing' }),
			goal('Pricing three', { angle: 120, category: 'pricing_and_plans', startPath: '/pricing' }),
			goal('Read the docs', { angle: 180, category: 'reading_content', startPath: '/docs' }),
			goal('Contact sales', { angle: 240, category: 'contacting', startPath: '/enterprise' })
		]);

		const firstThree = chosen.slice(0, 3).map((kept) => kept.category);

		expect(new Set(firstThree).size).toBe(3);
	});
});

describe('refusing actions', () => {
	const host = 'example.com';

	test('a control that changes something is refused, by name', () => {
		expect(
			refusalReason({ name: 'Delete project', region: 'main', rect: rect }, '', host)
		).toContain('Delete project');
		expect(refusalReason(undefined, 'Pay now button', host)).toContain('Pay now');
	});

	test('a link that leaves the site is refused, one to a subdomain is not', () => {
		const link = (href: string) => ({ name: 'Docs', region: 'nav' as const, rect, href });

		expect(refusalReason(link('https://github.com/acme'), '', host)).toContain('github.com');
		expect(refusalReason(link('mailto:sales@example.com'), '', host)).toContain('away');
		expect(refusalReason(link('https://docs.example.com/start'), '', host)).toBeUndefined();
		expect(refusalReason(link('https://example.com/pricing'), '', host)).toBeUndefined();
	});

	test('an ordinary control is allowed', () => {
		expect(refusalReason({ name: 'Pricing', region: 'nav', rect }, '', host)).toBeUndefined();
	});
});
