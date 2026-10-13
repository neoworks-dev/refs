// How a crawl's action graph is cut into flows: where they start, what keeps them going, and
// what is left out so a flow is never noise.
import { describe, expect, test } from 'bun:test';
import { cutFlowsFromGraph, type FlowAction, type FlowScreen } from '../crawler/flows.ts';

let nextActionId = 0;

function page(id: string, path: string, seq: number): FlowScreen {
	return { id, kind: 'page', path, seq };
}

function state(id: string, path: string, seq: number): FlowScreen {
	return { id, kind: 'state', path, seq };
}

function action(
	from: string,
	to: string,
	kind: FlowAction['kind'],
	label: string,
	region?: FlowAction['region']
): FlowAction {
	return { id: `action${nextActionId++}`, in: from, out: to, kind, label, region };
}

function stepIds(flow: { steps: { screen: FlowScreen }[] }): string[] {
	return flow.steps.map((step) => step.screen.id);
}

describe('where flows start and what keeps them going', () => {
	test('a navigation click opens a flow that takes in the pages under the same path', () => {
		const screens = [
			page('home', '/', 0),
			page('pricing', '/pricing', 1),
			page('enterprise', '/pricing/enterprise', 2),
			page('about', '/about', 3)
		];
		const actions = [
			action('home', 'pricing', 'navigate', 'Pricing', 'nav'),
			action('home', 'about', 'navigate', 'About us', 'footer'),
			action('pricing', 'enterprise', 'navigate', 'Enterprise', 'main')
		];

		const flows = cutFlowsFromGraph(screens, actions);

		expect(flows).toHaveLength(1);
		expect(flows[0].title).toBe('Pricing');
		expect(stepIds(flows[0])).toEqual(['pricing', 'enterprise']);
		expect(flows[0].steps[0].action).toBeUndefined();
		expect(flows[0].steps[1].action?.label).toBe('Enterprise');
	});

	test('a click back into the main navigation ends the flow and starts the next one', () => {
		const screens = [
			page('home', '/', 0),
			page('docs', '/docs', 1),
			page('guide', '/docs/guide', 2),
			page('pricing', '/pricing', 3),
			page('plans', '/pricing/plans', 4)
		];
		const actions = [
			action('home', 'docs', 'navigate', 'Docs', 'nav'),
			action('docs', 'guide', 'navigate', 'Guide', 'main'),
			action('docs', 'pricing', 'navigate', 'Pricing', 'nav'),
			action('pricing', 'plans', 'navigate', 'Plans', 'main')
		];

		const flows = cutFlowsFromGraph(screens, actions);

		expect(flows.map(stepIds)).toEqual([
			['docs', 'guide'],
			['pricing', 'plans']
		]);
	});

	test('a dialog that advances from state to state stays in the flow', () => {
		const screens = [
			page('home', '/', 0),
			page('team', '/team', 1),
			state('invite', '/team', 2),
			state('invite-details', '/team', 3)
		];
		const actions = [
			action('home', 'team', 'navigate', 'Team', 'nav'),
			action('team', 'invite', 'click', 'Invite', 'main'),
			action('invite', 'invite-details', 'click', 'Add details', 'other')
		];

		const flows = cutFlowsFromGraph(screens, actions);

		expect(flows.map(stepIds)).toEqual([['team', 'invite', 'invite-details']]);
	});

	test('states a page opens that lead nowhere are variants of the page, not steps', () => {
		const screens = [
			page('home', '/', 0),
			page('faq', '/faq', 1),
			state('first-answer', '/faq', 2),
			state('second-answer', '/faq', 3)
		];
		const actions = [
			action('home', 'faq', 'navigate', 'FAQ', 'nav'),
			action('faq', 'first-answer', 'click', 'What is it?', 'main'),
			action('faq', 'second-answer', 'click', 'Is it free?', 'main')
		];

		expect(cutFlowsFromGraph(screens, actions)).toEqual([]);
	});

	test('a progression word carries the flow out of its path, other links do not', () => {
		const screens = [
			page('home', '/', 0),
			page('signup', '/signup', 1),
			page('welcome', '/welcome', 2),
			page('terms', '/legal/terms', 3)
		];
		const actions = [
			action('home', 'signup', 'navigate', 'Sign up', 'nav'),
			action('signup', 'welcome', 'navigate', 'Continue', 'main'),
			action('signup', 'terms', 'navigate', 'Terms', 'footer')
		];

		const flows = cutFlowsFromGraph(screens, actions);

		expect(flows.map(stepIds)).toEqual([['signup', 'welcome']]);
	});

	test('the start page opens a flow of its own without swallowing the site', () => {
		const screens = [
			page('home', '/', 0),
			page('start', '/start', 1),
			page('start-next', '/start/next', 2),
			page('blog', '/blog', 3)
		];
		const actions = [
			action('home', 'start', 'navigate', 'Get started', 'main'),
			action('start', 'start-next', 'navigate', 'Next', 'main'),
			action('home', 'blog', 'navigate', 'Blog', 'main')
		];

		const flows = cutFlowsFromGraph(screens, actions);

		expect(flows).toHaveLength(1);
		expect(flows[0].title).toBe('Home');
		expect(stepIds(flows[0])).toEqual(['home', 'start', 'start-next']);
	});

	test('a locale prefix on the start page is not the section of every page', () => {
		const screens = [
			page('home', '/de', 0),
			page('pricing', '/de/pricing', 1),
			page('plans', '/de/pricing/plans', 2),
			page('blog', '/de/blog', 3)
		];
		const actions = [
			action('home', 'pricing', 'navigate', 'Preise', 'nav'),
			action('home', 'blog', 'navigate', 'Blog', 'nav'),
			action('pricing', 'plans', 'navigate', 'Pläne', 'main'),
			action('pricing', 'blog', 'navigate', 'Blog', 'main')
		];

		const flows = cutFlowsFromGraph(screens, actions);

		expect(flows.map(stepIds)).toEqual([['pricing', 'plans']]);
	});
});

describe('sections and local menus', () => {
	test('pages of a section join its flow even when the crawler found them from elsewhere', () => {
		const screens = [
			page('home', '/', 0),
			page('customers', '/customers', 1),
			page('ramp', '/customers/ramp', 2),
			page('openai', '/customers/openai', 3)
		];
		const actions = [
			action('home', 'customers', 'navigate', 'Customers', 'nav'),
			action('home', 'ramp', 'navigate', 'Ramp story', 'main'),
			action('home', 'openai', 'navigate', 'OpenAI story', 'main')
		];

		const flows = cutFlowsFromGraph(screens, actions);

		expect(flows.map(stepIds)).toEqual([['customers', 'ramp', 'openai']]);
		expect(flows[0].steps[1].action?.label).toBe('Ramp story');
	});

	test('a navigation link that stays in its own section is a local menu, not a new flow', () => {
		const screens = [
			page('home', '/', 0),
			page('contact', '/contact', 1),
			page('support', '/contact/support', 2)
		];
		const actions = [
			action('home', 'contact', 'navigate', 'Contact', 'nav'),
			action('contact', 'support', 'navigate', 'Support', 'nav')
		];

		const flows = cutFlowsFromGraph(screens, actions);

		expect(flows.map(stepIds)).toEqual([['contact', 'support']]);
		expect(flows[0].title).toBe('Contact');
	});

	test('two navigation entries into one section make one flow', () => {
		const screens = [
			page('home', '/', 0),
			page('products', '/products', 1),
			page('previews', '/products/previews', 2)
		];
		const actions = [
			action('home', 'products', 'navigate', 'Products', 'nav'),
			action('home', 'previews', 'navigate', 'Previews', 'nav')
		];

		expect(cutFlowsFromGraph(screens, actions).map(stepIds)).toEqual([['products', 'previews']]);
	});
});

describe('keeping flows free of noise', () => {
	test('the same page with another query or locale is not a next step', () => {
		const screens = [
			page('home', '/de', 0),
			page('login', '/login', 1),
			page('login-redirect', '/login?redirect=%2Fapp', 2),
			page('products', '/de/products', 3),
			page('products-english', '/products', 4)
		];
		const actions = [
			action('home', 'login', 'navigate', 'Login', 'nav'),
			action('home', 'products', 'navigate', 'Products', 'nav'),
			action('login', 'login-redirect', 'navigate', 'Sign in', 'main'),
			action('home', 'products-english', 'navigate', 'Products', 'main')
		];

		expect(cutFlowsFromGraph(screens, actions)).toEqual([]);
	});
	test('a screen belongs to one flow only and a lone screen is not a flow', () => {
		const screens = [
			page('home', '/', 0),
			page('docs', '/docs', 1),
			page('shared', '/docs/shared', 2),
			page('pricing', '/pricing', 3)
		];
		const actions = [
			action('home', 'docs', 'navigate', 'Docs', 'nav'),
			action('home', 'pricing', 'navigate', 'Pricing', 'nav'),
			action('docs', 'shared', 'navigate', 'Shared', 'main'),
			action('pricing', 'shared', 'navigate', 'Continue', 'main')
		];

		const flows = cutFlowsFromGraph(screens, actions);

		expect(flows.map(stepIds)).toEqual([['docs', 'shared']]);
	});

	test('actions that circle back do not loop the walk', () => {
		const screens = [
			page('home', '/', 0),
			page('docs', '/docs', 1),
			page('guide', '/docs/guide', 2)
		];
		const actions = [
			action('home', 'docs', 'navigate', 'Docs', 'nav'),
			action('docs', 'guide', 'navigate', 'Guide', 'main'),
			action('guide', 'docs', 'navigate', 'Docs', 'main')
		];

		expect(cutFlowsFromGraph(screens, actions).map(stepIds)).toEqual([['docs', 'guide']]);
	});

	test('a flow is titled after its entry click, shortened, or else after its path', () => {
		const longLabel = 'Explore everything the platform can do for your team and then some more';
		const screens = [
			page('home', '/', 0),
			page('platform', '/platform', 1),
			page('platform-more', '/platform/more', 2),
			page('jobs', '/jobs', 3),
			page('jobs-more', '/jobs/more', 4)
		];
		const actions = [
			action('home', 'platform', 'navigate', longLabel, 'nav'),
			action('platform', 'platform-more', 'navigate', 'More', 'main'),
			action('home', 'jobs', 'navigate', '  ', 'nav'),
			action('jobs', 'jobs-more', 'navigate', 'More', 'main')
		];

		const titles = cutFlowsFromGraph(screens, actions).map((flow) => flow.title);

		expect(titles[0].length).toBeLessThanOrEqual(60);
		expect(titles[0].startsWith('Explore everything')).toBe(true);
		expect(titles[1]).toBe('/jobs');
	});

	test('a crawl recorded before regions existed only has its start page to open a flow', () => {
		const screens = [
			page('home', '/', 0),
			page('docs', '/docs', 1),
			page('guide', '/docs/guide', 2)
		];
		const actions = [
			action('home', 'docs', 'navigate', 'Docs'),
			action('docs', 'guide', 'navigate', 'Guide')
		];

		expect(cutFlowsFromGraph(screens, actions)).toEqual([]);
	});
});
