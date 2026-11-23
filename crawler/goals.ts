// Planning what to capture on a site. One call to the model looks at the landing page and, with
// what it knows about the product, lists the flows worth recording; trajectory.ts then runs each.
import type { Page } from 'playwright';
import { chat, modelConfigFromEnv, imageDataUri, reasoningFromEnv } from '#lib/server/models.ts';
import { FLOW_CATEGORIES, FLOW_CATEGORY_DESCRIPTIONS, type FlowCategory } from '#lib/types.ts';
import { isSameSite, normalizeUrl } from './rules.ts';

const models = modelConfigFromEnv(process.env);

/** One flow to record, as the model planned it. */
export interface PlannedFlow {
	/** The goal in a visitor's words, which is also the flow's title. */
	goal: string;
	category: FlowCategory;
	/** The area of the site the model filed the flow under. */
	area: string;
	/** Where the browser starts: usually the landing page, sometimes a deeper page the model knows. */
	startUrl: string;
	/** What the screen shows once the goal is reached. */
	success: string;
	/** The goal needs the demo account's login, so its browser starts logged in. */
	signedIn: boolean;
}

/** What the browser agent is told to do: the goal, and how it can tell it is finished. */
export function agentGoal(flow: Pick<PlannedFlow, 'goal' | 'success'>): string {
	return flow.success === '' ? flow.goal : `${flow.goal} (done when: ${flow.success})`;
}

// --- reading the landing page -------------------------------------------------------------------

/** What the model is told about the page besides its screenshot, which is cheap to read and says a lot. */
export interface LandingPage {
	url: string;
	title: string;
	description: string;
	/** Links in the header and navigation, as "Label (/path)". */
	navigation: string[];
	/** Links in the footer, which list the site's areas more completely than the header does. */
	footer: string[];
	/** Links in the page body, which show what the page itself promotes. */
	content: string[];
	headings: string[];
}

/** Long lists only cost tokens; the first links of a region are its most important. */
const MAX_NAVIGATION_LINKS = 50;
const MAX_FOOTER_LINKS = 60;
const MAX_CONTENT_LINKS = 30;
const MAX_HEADINGS = 25;
const MAX_HEADING_CHARACTERS = 100;
const MAX_LINK_LABEL_CHARACTERS = 50;

/** Reads the title, description, links and headings of the page the browser shows. */
export async function readLandingPage(page: Page, siteHost: string): Promise<LandingPage> {
	const details = await page.evaluate(() => window.pageInspector!.pageDetails());
	const links = await page.evaluate(() => window.pageInspector!.links());
	const headings = await page.locator('h1, h2, h3').allInnerTexts();

	const linesByRegion = { nav: [], footer: [], main: [], other: [] } as Record<string, string[]>;
	const seen = new Set<string>();
	for (const link of links) {
		const label = link.text.replace(/\s+/g, ' ').trim().slice(0, MAX_LINK_LABEL_CHARACTERS);
		const destination = normalizeUrl(link.href);
		// Off-site links lead somewhere the agent may not go; a link to the same page is no news.
		if (label === '' || destination === undefined || !isSameSite(destination, siteHost)) continue;
		const path = new URL(destination).pathname;
		const line = `${label} (${path})`;
		if (seen.has(line)) continue;
		seen.add(line);
		linesByRegion[link.region].push(line);
	}
	return {
		url: page.url(),
		title: details.title,
		description: details.description,
		navigation: linesByRegion.nav.slice(0, MAX_NAVIGATION_LINKS),
		footer: linesByRegion.footer.slice(0, MAX_FOOTER_LINKS),
		content: [...linesByRegion.main, ...linesByRegion.other].slice(0, MAX_CONTENT_LINKS),
		headings: headings
			.map((heading) => heading.replace(/\s+/g, ' ').trim().slice(0, MAX_HEADING_CHARACTERS))
			.filter((heading) => heading !== '')
			.slice(0, MAX_HEADINGS)
	};
}

// --- the plan ----------------------------------------------------------------------------------

/**
 * Output tokens the plan may take. A plan is long (about 100 tokens per flow) and a server rejects
 * a request whose prompt and output together exceed its context window, so this has to be set to
 * what the model server allows: the default fits the local 16k window with room for the prompt,
 * and a 32k RunPod worker can be given more with `REFS_PLAN_MAX_TOKENS`.
 */
const PLAN_MAX_TOKENS = Number(process.env.REFS_PLAN_MAX_TOKENS ?? 10_000);
/**
 * How long a hosted planner thinks before it writes the plan, from `REFS_PLAN_REASONING`. GLM-5.3
 * Flash on medium listed 160 flows for GitHub where low listed 37 (bench/runs/github-com).
 */
const PLAN_REASONING = reasoningFromEnv('REFS_PLAN_REASONING', process.env.REFS_PLAN_REASONING);
/** Typical size of one planned flow in tokens, to tell the model how many fit in the budget. */
const TOKENS_PER_FLOW = 120;
/** The area names, the product summary and the JSON around them. */
const PLAN_OVERHEAD_TOKENS = 800;
/**
 * Upper bounds in the schema, not targets. A big product like Figma has dozens of areas and
 * hundreds of flows; these only stop a runaway answer. The budget above is what usually binds.
 */
const MAX_AREAS = 40;
const MAX_FLOWS_PER_AREA = 15;
const MAX_GOAL_CHARACTERS = 160;
const MAX_SUCCESS_CHARACTERS = 160;
const MAX_START_CHARACTERS = 200;
const MAX_NAME_CHARACTERS = 60;

/**
 * Categories left out of a plan, because something else covers them. With a demo account, the
 * sign-up, the login and the onboarding are flows the crawler records itself, and planning them
 * again only produced a second sign-up. Without one, nothing behind a login can be tried.
 */
function excludedCategories(hasAccount: boolean): FlowCategory[] {
	return hasAccount
		? ['signing_up', 'logging_in', 'onboarding']
		: ['onboarding', 'logging_in', 'settings'];
}

export interface PlanRequest {
	siteName: string;
	siteUrl: string;
	host: string;
	viewport: 'desktop' | 'mobile';
	/** The landing page screenshot. */
	image: Buffer | Uint8Array;
	page: LandingPage;
	/** The site has a demo account the agent can log in with. */
	hasAccount: boolean;
	/** The page is the landing page of the signed-in account: plan what is behind the login. */
	signedIn: boolean;
}

/** The longest an image the planner sees may be on a side; layout and headings stay readable. */
const PLAN_IMAGE_MAX_SIDE = 1280;

/**
 * Asks the model for the flows worth recording on a site, from its landing page and its own
 * knowledge of the product. The answer is nested by area, so the model first has to survey what the
 * site consists of before it lists flows; that is what makes the list cover the whole site instead
 * of the first few things that come to mind. The flows come back in the order to try them, which
 * matters when a run is bounded: the first flow of every area, then the second of every area.
 */
export async function planFlows(request: PlanRequest): Promise<PlannedFlow[]> {
	const { page, signedIn } = request;
	const hasAccount = request.hasAccount || signedIn;
	const excluded = excludedCategories(hasAccount);
	const categories = FLOW_CATEGORIES.filter((category) => !excluded.includes(category));
	const flowRoom = Math.floor((PLAN_MAX_TOKENS - PLAN_OVERHEAD_TOKENS) / TOKENS_PER_FLOW);

	// Property order is decoding order: the model first says what the site is, then names its
	// areas, then lists flows area by area. Each flow is worded first and judged after, because a
	// small model breaks the "no payment" rule when it writes but answers a plain yes or no about
	// the sentence it just wrote far more reliably.
	const schema = {
		type: 'object',
		properties: {
			product: {
				type: 'string',
				maxLength: 300,
				description: 'What the site is and who uses it, in one or two sentences.'
			},
			areas: {
				type: 'array',
				minItems: 1,
				maxItems: MAX_AREAS,
				items: {
					type: 'object',
					properties: {
						name: { type: 'string', maxLength: MAX_NAME_CHARACTERS },
						flows: {
							type: 'array',
							minItems: 1,
							maxItems: MAX_FLOWS_PER_AREA,
							items: {
								type: 'object',
								properties: {
									goal: { type: 'string', maxLength: MAX_GOAL_CHARACTERS },
									category: { type: 'string', enum: categories },
									start: {
										type: 'string',
										maxLength: MAX_START_CHARACTERS,
										description: 'A path on the site that starts with a slash, like / or /pricing.'
									},
									needs_login: { type: 'boolean' },
									needs_payment_or_private_data: { type: 'boolean' },
									success: { type: 'string', maxLength: MAX_SUCCESS_CHARACTERS },
									start_shows_success: {
										type: 'boolean',
										description:
											'True when the start page itself already shows what success describes, before any action.'
									}
								},
								required: [
									'goal',
									'category',
									'start',
									'needs_login',
									'needs_payment_or_private_data',
									'success',
									'start_shows_success'
								],
								additionalProperties: false
							}
						}
					},
					required: ['name', 'flows'],
					additionalProperties: false
				}
			}
		},
		required: ['product', 'areas'],
		additionalProperties: false
	};

	const list = (lines: string[]) => (lines.length === 0 ? '(none found)' : lines.join('; '));
	const categoryLines = categories
		.map((category) => `- ${category}: ${FLOW_CATEGORY_DESCRIPTIONS[category]}`)
		.join('\n');
	const users = signedIn ? 'a signed-in user' : 'a visitor';
	let accountRules: string;
	if (signedIn) {
		accountRules =
			'- The screenshot is the site as a signed-in user sees it, so every flow needs the login: ' +
			'set needs_login to true. Prefer flows that explore the product: open an area of the ' +
			'navigation, switch a tab, open the profile or account menu or a settings page, search ' +
			'or filter a list and open one item, open the thing the product is for (a file, a ' +
			'project, a document, a dashboard) and use its main controls.\n' +
			'- Never list signing up, logging in, signing in with Google or GitHub, paying, entering ' +
			'a phone number, deleting anything, inviting other people or changing billing.\n';
	} else if (hasAccount) {
		accountRules =
			'- The browser agent has a demo account for this site and can sign in with its email and ' +
			'password. Flows behind the login are planned separately later, so list what a visitor ' +
			'who is not signed in can do, and set needs_login to false.\n' +
			'- Never list signing up or logging in themselves, signing in with Google or GitHub, ' +
			'paying, entering a phone number, deleting anything, inviting other people or changing billing.\n';
	} else {
		accountRules =
			'- The agent has no account, so it cannot log in: never list logging in, signing in with ' +
			'Google or GitHub, or anything that needs an account. Starting to sign up or to request a ' +
			"demo is fine when the flow ends where the form asks for personal data, like 'start the " +
			"free trial and stop at the first field that asks for an email'.\n";
	}
	const prompt =
		`You are planning what to capture from the website ${request.siteName} (${request.host}) ` +
		'for a design reference library. A browser agent will later try each flow you list, on a ' +
		`${request.viewport} screen, and the screens it passes through are saved for designers to ` +
		`study. The screenshot shows ${signedIn ? 'the landing page of a signed-in user' : 'the landing page'}.\n\n` +
		`Use the page AND everything you know about ${request.siteName} as a product. Most flows are ` +
		'not visible on this page. You know that a shop has product pages, filters, a cart and a ' +
		'checkout, that a design tool has a file browser, an editor with panels, comments and a ' +
		'plugin library, and that a developer platform has docs, an API reference and a dashboard. ' +
		'List those too, as long as the agent can reach them from this page by clicking.\n\n' +
		`The page\nURL: ${page.url}\nTitle: ${page.title}\nDescription: ${page.description}\n` +
		`Navigation: ${list(page.navigation)}\nFooter: ${list(page.footer)}\n` +
		`Links in the page: ${list(page.content)}\nHeadings: ${list(page.headings)}\n\n` +
		'How to answer\n' +
		'1. product: what the site is and who uses it.\n' +
		'2. areas: the distinct parts of the site and the product, such as the marketing pages, ' +
		'pricing, the docs, a store, a help center, or the parts of an app. Name every part you know ' +
		'of, not only the ones in the navigation.\n' +
		`3. flows: for each area, what ${users} does there. A flow is one short run of steps that ` +
		'gets something done, like comparing plans, filtering a product list and opening a result, ' +
		'or reading a doc. Order them within the area by how typical they are for this site.\n\n' +
		'How many is your call. A small site or a shop deserves about a dozen, a big product with ' +
		`many features deserves many more. You have room for at most ${flowRoom} flows in total. ` +
		'Do not pad the list: every flow must show something the others do not, and you stop when ' +
		'you run out of distinct flows.\n\n' +
		'For each flow:\n' +
		"- goal: one sentence in the visitor's own words that names the concrete things on this " +
		'site (a menu, a tab, a plan, a feature, a field), not a generic activity. Good, from ' +
		"other sites: 'Filter the sneakers by size 9 and open the first result' and 'Switch " +
		"the pricing toggle to yearly and compare the Team and Business plans'. Bad: 'Explore the " +
		"features' and 'Learn about the product'.\n" +
		`- category: what the flow is about. Allowed categories:\n${categoryLines}\n` +
		'- start: the path where the agent starts, such as /pricing. Use / (the page above) unless ' +
		'the flow can only start somewhere else and you are sure that page exists. The agent finds ' +
		'its own way from there.\n' +
		'- needs_login: true when the flow can only be done signed in to an account.\n' +
		'- needs_payment_or_private_data: true when the flow cannot be done without payment ' +
		'details, a phone number, a postal address or other real personal data.\n' +
		'- success: what the screen shows once the goal is reached.\n\n' +
		'Rules:\n' +
		'- Prefer flows that take several steps over ones that follow a single link: open a menu ' +
		'and pick an entry, switch a tab or a billing toggle, filter or search a list and open a ' +
		'result, go through a multi-step form up to the point where it asks for personal data. A ' +
		"flow that only opens one page, like 'open the pricing page', is allowed but comes last in " +
		'its area.\n' +
		'- A flow must need at least one action on its start page. Do not list something that page ' +
		"already shows, like 'read the docs' when the flow starts in the docs, or 'explore the " +
		"features' on a features page.\n" +
		'- A flow that ends before the payment is valuable: put something in the cart and go to ' +
		'the checkout, and stop at the form that asks for an address.\n' +
		accountRules +
		'- Only list what this kind of site really offers. Do not invent pages or features.\n';

	const { uri } = await imageDataUri(request.image, PLAN_IMAGE_MAX_SIDE);
	const answer = await chat(
		models.vlm,
		[
			{
				role: 'user',
				content: [
					{ type: 'image_url', image_url: { url: uri } },
					{ type: 'text', text: prompt }
				]
			}
		],
		{ schema: { name: 'flow_plan', schema }, maxTokens: PLAN_MAX_TOKENS, reasoning: PLAN_REASONING }
	);
	const plan = JSON.parse(answer) as {
		product: string;
		areas: {
			name: string;
			flows: {
				goal: string;
				category: FlowCategory;
				start: string;
				needs_login: boolean;
				needs_payment_or_private_data: boolean;
				success: string;
				start_shows_success: boolean;
			}[];
		}[];
	};

	const seenGoals = new Set<string>();
	const flowsByArea = plan.areas.map((area) =>
		area.flows
			.filter((flow) => !flow.needs_payment_or_private_data && (hasAccount || !flow.needs_login))
			// The planner likes to start a flow where it ends, like "Open the pricing page" from
			// /pricing (GLM-5.3 Flash did for half of GitHub's flows), and the agent is done before it
			// does anything. Such a flow starts from the landing page instead, below, and one whose
			// success the landing page itself already shows has nothing to record.
			.filter(
				(flow) =>
					!flow.start_shows_success ||
					resolveStart(flow.start, request.siteUrl, request.host) !== request.siteUrl
			)
			.filter((flow) => {
				// The areas overlap, and the same flow listed twice would be recorded twice.
				const key = flow.goal
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, ' ')
					.trim();
				if (seenGoals.has(key)) return false;
				seenGoals.add(key);
				return true;
			})
			.map((flow) => ({
				goal: flow.goal,
				category: flow.category,
				area: area.name,
				startUrl: flow.start_shows_success
					? request.siteUrl
					: resolveStart(flow.start, request.siteUrl, request.host),
				success: flow.success,
				signedIn: signedIn || flow.needs_login
			}))
	);
	const planned = interleave(flowsByArea);

	// The planner answers the judgements above unevenly: once it marked every visitor flow of
	// linear.app in a way that left none. Saying what was left out shows which one it was.
	const answered = plan.areas.flatMap((area) => area.flows);
	if (planned.length < answered.length) {
		const count = (judged: (flow: (typeof answered)[number]) => boolean) =>
			answered.filter(judged).length;
		console.log(
			`  the planner listed ${answered.length} flows and ${planned.length} are kept. Of the listed ones, ` +
				`${count((flow) => flow.needs_payment_or_private_data)} need payment or personal data, ` +
				`${count((flow) => !hasAccount && flow.needs_login)} need a login the agent does not have, and ` +
				`${count((flow) => flow.start_shows_success && resolveStart(flow.start, request.siteUrl, request.host) === request.siteUrl)} ` +
				'are already shown by the landing page. The rest are duplicates.'
		);
	}
	return planned;
}

/**
 * The URL a planned flow starts at. The model names a path it believes exists; anything that is
 * not an address on the site itself falls back to the landing page.
 */
function resolveStart(start: string, siteUrl: string, host: string): string {
	// Small models write the name of a page ("New arrivals") where a path belongs.
	if (!/^(\/|https?:\/\/)\S*$/.test(start)) return siteUrl;
	const resolved = normalizeUrl(start, siteUrl);
	return resolved !== undefined && isSameSite(resolved, host) ? resolved : siteUrl;
}

/** The first flow of every list, then the second of every list, and so on. */
export function interleave<Item>(lists: Item[][]): Item[] {
	const longest = Math.max(0, ...lists.map((list) => list.length));
	const ordered: Item[] = [];
	for (let position = 0; position < longest; position++) {
		for (const list of lists) {
			if (position < list.length) ordered.push(list[position]);
		}
	}
	return ordered;
}
