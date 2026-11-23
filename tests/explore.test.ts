// What goal-directed exploration decides without a browser: in what order planned flows run, and
// which actions it refuses to carry out.
import { describe, expect, test } from 'bun:test';
import { refusalReason } from '../crawler/agent.ts';
import { agentGoal, interleave } from '../crawler/goals.ts';

const rect = { x: 0, y: 0, w: 10, h: 10 };

describe('ordering planned flows', () => {
	test('the first flow of every area comes before the second flow of any area', () => {
		const ordered = interleave([
			['pricing 1', 'pricing 2', 'pricing 3'],
			['docs 1'],
			['store 1', 'store 2']
		]);

		expect(ordered).toEqual([
			'pricing 1',
			'docs 1',
			'store 1',
			'pricing 2',
			'store 2',
			'pricing 3'
		]);
	});

	test('no areas leave nothing to try', () => {
		expect(interleave([])).toEqual([]);
	});
});

describe('the goal the agent works on', () => {
	test('names the success criterion, so the agent knows when to stop', () => {
		expect(agentGoal({ goal: 'Compare the plans', success: 'A table of plans is shown' })).toBe(
			'Compare the plans (done when: A table of plans is shown)'
		);
	});

	test('a goal without a criterion is left as it is', () => {
		expect(agentGoal({ goal: 'Compare the plans', success: '' })).toBe('Compare the plans');
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

	test('submitting a form is allowed for a demo account, never for a visitor', () => {
		const identity = { email: 'demo+acme@gmail.com', password: 'secret', name: 'Alex' };
		const submit = { name: 'Confirm password', region: 'main' as const, rect };

		expect(refusalReason(submit, '', host)).toContain('Confirm password');
		expect(refusalReason(submit, '', host, identity)).toBeUndefined();
		expect(refusalReason({ ...submit, name: 'Pay now' }, '', host, identity)).toContain('Pay now');
	});

	test('logging in through another service is refused', () => {
		const google = { name: 'Continue with Google', region: 'main' as const, rect };

		expect(refusalReason(google, '', host)).toContain('another service');
	});
});
