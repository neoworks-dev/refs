// Benchmark of the first step of a crawl: planning the flows of a site from its landing page.
// One run is one model. Every run gets the same snapshot of the page (screenshot, URL, clickable
// elements), example flows from other products and the same instructions, and returns a plan in
// the same JSON schema. What the call cost, in tokens, dollars and seconds, goes into a summary
// next to the plan and Mobbin's flows for the same site, and into a table of all runs of the site.
//
// `bun bench/plan.ts --model z-ai/glm-5.3-flash[@streamlake[/fp8]] [--site https://github.com]
//   [--reasoning none] [--max-tokens 16000] [--retake] [--dry-run]`
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { imageDataUri } from '#lib/server/models.ts';
import { bareHost, slugFromHost } from '../crawler/rules.ts';
import {
	callModel,
	parseModelSpec,
	REASONING_LEVELS,
	resolveModel,
	type Reasoning
} from './models.ts';
import { loadOrTakeSnapshot, type Snapshot } from './snapshot.ts';

const { values } = parseArgs({
	options: {
		// An OpenRouter id, or hcompany/<model> for H Company's Holo models. An OpenRouter id may
		// pin the upstream provider and its quantization the way OpenRouter's pages write it, like
		// z-ai/glm-5.3-flash@streamlake/fp8. There is no default: every run costs money, so which
		// model runs is always a choice.
		model: { type: 'string' },
		site: { type: 'string', default: 'https://github.com' },
		reasoning: { type: 'string', default: 'none' },
		// Mobbin lists about 160 flows for GitHub, and a flow takes 80 to 120 tokens in a plan.
		'max-tokens': { type: 'string', default: '32000' },
		retake: { type: 'boolean', default: false },
		'dry-run': { type: 'boolean', default: false }
	}
});

if (!REASONING_LEVELS.includes(values.reasoning as Reasoning)) {
	throw new Error(`--reasoning must be one of ${REASONING_LEVELS.join(', ')}`);
}
const reasoning = values.reasoning as Reasoning;
const maxTokens = Number(values['max-tokens']);
if (values.model === undefined && !values['dry-run']) {
	throw new Error('Name the model to run: --model qwen/qwen3.8-27b');
}
// Looked up before the snapshot, so a typo fails before the browser opens.
const modelSpec = values.model === undefined ? undefined : parseModelSpec(values.model);
const benchModel = modelSpec === undefined ? undefined : await resolveModel(modelSpec.id);
const upstream = modelSpec?.upstream;

const host = bareHost(new URL(values.site).hostname);
const siteSlug = slugFromHost(host);
const siteDirectory = join(import.meta.dirname, 'runs', siteSlug);
const { snapshot, screenshot } = await loadOrTakeSnapshot(
	join(siteDirectory, 'snapshot'),
	values.site,
	{ retake: values.retake }
);

// --- what the model is told ----------------------------------------------------------------------

/**
 * The planner sees the screenshot at this size. Layout and headings stay readable, and the
 * crawler's own planner uses the same size, so the benchmark measures what a crawl would spend.
 */
const IMAGE_MAX_SIDE = 1280;
/** Link text can be a whole paragraph (a card that is one big link), and the model needs a hint. */
const MAX_NAME_CHARACTERS = 80;

/**
 * Where an element leads, as a path on the site or a full address elsewhere. Links that run a
 * script or open a mail program lead nowhere a browser agent can follow.
 */
function destination(href: string): string | undefined {
	const target = new URL(href);
	if (!target.protocol.startsWith('http')) return undefined;
	if (bareHost(target.hostname) === host) return `${target.pathname}${target.search}`;
	return `${target.host}${target.pathname}`;
}

/**
 * The clickable elements as one line each, grouped by the part of the page they sit in, because
 * the navigation and the footer say most about the site's areas. Unnamed controls (icon buttons
 * without a label) tell the model nothing and are left out, and so are exact repeats.
 */
function describeClickables(clickables: Snapshot['clickables']): string {
	const regions = [
		{ region: 'nav', title: 'Header and navigation' },
		{ region: 'main', title: 'Page content' },
		{ region: 'other', title: 'Elsewhere on the page' },
		{ region: 'footer', title: 'Footer' }
	];
	const seen = new Set<string>();
	const sections: string[] = [];
	for (const { region, title } of regions) {
		const lines: string[] = [];
		for (const clickable of clickables.filter((candidate) => candidate.region === region)) {
			const name = clickable.name.slice(0, MAX_NAME_CHARACTERS);
			const target = clickable.href === undefined ? undefined : destination(clickable.href);
			if (name === '' && target === undefined) continue;
			let line = `${clickable.role} "${name}"`;
			if (target !== undefined) line += ` -> ${target}`;
			if (!clickable.visible) line += ' (hidden)';
			if (seen.has(line)) continue;
			seen.add(line);
			lines.push(`- ${line}`);
		}
		if (lines.length > 0) sections.push(`${title}:\n${lines.join('\n')}`);
	}
	return sections.join('\n\n');
}

/**
 * A whole plan of another product, as a tree of areas and flow titles, at the scale and depth of
 * Mobbin's flow lists: about a hundred flows for a big product, almost all of them signed in, and
 * flows nested two or three deep inside what an earlier flow created. A model shown a handful of
 * flows plans a handful (GLM-5.3 Flash listed 37 flows for GitHub, where Mobbin lists 160).
 *
 * The example is Notion, not the site under test, so it cannot be copied, and its titles avoid the
 * ones Mobbin lists for GitHub, so a model that names those for GitHub does so on its own.
 */
const EXAMPLE_TREE = `Notion (notion.com), areas and flow titles, indented flows continue from the one above:
- Onboarding
  - Choosing a use case
  - Picking starter templates
- Sidebar
  - Creating a page
    - Adding a cover image
    - Changing the page icon
    - Adding a table
      - Adding a property
      - Filtering a table
      - Sorting a table
      - Switching to board view
      - Grouping by status
    - Adding a to-do list
    - Adding a callout
    - Embedding a link preview
    - Turning a block into a page
    - Moving a page
    - Adding a comment
      - Resolving a comment
    - Locking a page
    - Viewing page history
    - Exporting a page as PDF
  - Favoriting a page
  - Searching pages
    - Filtering search results
  - Opening the trash
- Templates
  - Browsing the template gallery
    - Previewing a template
    - Duplicating a template
- Calendar
  - Creating an event
    - Changing the event time
  - Switching to week view
- Inbox
  - Archiving a notification
  - Filtering by unread
- Settings
  - Changing the appearance
  - Editing language and region
  - Editing email preferences
  - Viewing connected apps
  - Changing the start page
  - Viewing plan details
- Upgrading
  - Comparing plans in the upgrade dialog
- Help
  - Opening the help center
  - Searching help articles
- Pricing (visitors)
  - Comparing plans
  - Opening the sales contact form`;

/**
 * A few flows of the tree above written out field by field, so the shape of an answer and the
 * wording of goals and success criteria are clear, including a chain three flows long.
 */
const EXAMPLE_FLOWS = [
	{
		id: 'n1',
		continues_from: '',
		title: 'Creating a page',
		goal: 'Click New page in the sidebar, give the page the title Weekly plan and start it empty',
		start: '/',
		needs_login: true,
		needs_payment_or_private_data: false,
		success: 'An empty page titled Weekly plan is open'
	},
	{
		id: 'n2',
		continues_from: 'n1',
		title: 'Adding a table',
		goal: "Type /table on the page and pick 'Table view' to insert an inline database",
		start: '',
		needs_login: true,
		needs_payment_or_private_data: false,
		success: 'The page shows an empty table with Name and Tags columns'
	},
	{
		id: 'n3',
		continues_from: 'n2',
		title: 'Switching to board view',
		goal: 'Add a Board view to the table from its view menu',
		start: '',
		needs_login: true,
		needs_payment_or_private_data: false,
		success: 'The table shows its rows as cards in columns'
	},
	{
		id: 'n4',
		continues_from: '',
		title: 'Comparing plans',
		goal: 'Switch the pricing toggle to yearly billing and compare the Plus and Business plans',
		start: '/pricing',
		needs_login: false,
		needs_payment_or_private_data: false,
		success: 'The plan cards show yearly prices'
	}
];

const prompt = `You are planning what to capture from ${host} for a design reference library like Mobbin: a collection of screenshots of real products, organised by the screens of each product and the flows people go through on them, that designers browse for ideas. A browser agent will later run every flow you list on a desktop screen, and each screen it passes through is saved.

You get the landing page: its screenshot (above), its URL, and every element on it that can be clicked or typed into. Elements marked (hidden) are in the page but not shown yet, like the entries of a closed menu.

What matters most is the product itself, the part people use after signing in: its main screens and what people do on them. The marketing pages, pricing and docs are worth a few flows, not most of the plan. Most of the product is not visible on this landing page, so use everything you know about ${host} as a product, as long as the agent can get there by clicking and typing.

The agent has a demo account for this site and is signed in where a flow needs it. Mark those flows with needs_login. Signing up and logging in are recorded separately, so do not list them. What the agent creates belongs to the demo account, so creating, editing and uploading things there is fine.

Everything the agent creates or changes stays inside the demo account: its own projects, files, documents and settings. Other people's things may be opened and looked at, but never changed or reacted to: no comments, issues, stars, likes, follows, messages, forks or contributions on anything the demo account does not own. When a flow needs something to act on, create it first in an earlier flow and continue from there. The agent also never enters payment details, a phone number, a postal address or other real personal data, and never deletes anything, invites other people or changes billing. A flow may go up to the form that asks for such data and stop there.

How to answer
1. product: what the product is and who uses it, in one or two sentences.
2. areas: the screens of the product, like an inbox, a project page, an editor, a file browser or the settings, plus the marketing pages that matter. Name every screen you know of, not only the ones reachable from this page.
3. flows: for each area, what people do there. Order the flows within an area by how typical they are for this product.

A flow is one task, and small tasks count: opening a panel, switching a toggle, renaming something, filtering a list. Split a long journey into one flow per task, and chain them with continues_from: a flow that starts inside what an earlier flow created or opened names that flow's id, and the agent runs the earlier flow first. Chains can be several flows deep, like creating a page, adding a table to it, then switching the table to a board. Every flow must change something on the screen; opening a page and reading it is not a flow on its own. Every flow must show screens or states the others do not.

How many flows is your call. A shop or a simple marketing site has a dozen or two. A big product with many screens, like a design tool, a project tracker or a developer platform, has well over a hundred, because every screen has several things to do on it, and its settings alone have a dozen. Go through every screen of the product and list everything people do there before you stop. Stop when you run out of distinct flows rather than padding the list.

For each flow:
- id: a short id that is unique in your plan, like g1, g2.
- continues_from: the id of the flow this one continues from, listed before it, or an empty string when it starts at a URL.
- title: the flow's name as a library would show it, a gerund of two to five words, like "Creating an issue" or "Filtering notifications".
- goal: one sentence telling the agent what to do, naming the concrete things on this product (a menu, a tab, a button, a field).
- start: where the agent starts when continues_from is empty. A path on this site that starts with a slash, like /pricing, or a full URL for another part of the same site. Use / unless you are sure the page exists. An empty string when continues_from is set.
- needs_login: true when the flow can only be done signed in.
- needs_payment_or_private_data: true when the flow cannot be done without payment details, a phone number, a postal address or other real personal data.
- success: what the screen shows once the goal is reached.

Only list what this product really offers. Do not invent screens or features.

An example of a whole plan for another product, to show the scale, the screens as areas and how deep flows nest:
${EXAMPLE_TREE}

Some of its flows written out, one per line, to show the fields:
${EXAMPLE_FLOWS.map((flow) => JSON.stringify(flow)).join('\n')}

The page
URL: ${snapshot.url}
Title: ${snapshot.title}
Description: ${snapshot.description}

${describeClickables(snapshot.clickables)}

Now plan the flows for ${host}.`;

// Property order is the order the model writes in: what the product is, then its screens, then the
// flows screen by screen, so it surveys the whole product before listing anything. Each flow is
// worded before it is judged, because a model checks a sentence it has written more reliably than
// it follows a rule while writing. Chains are ids rather than nested flows, because several
// providers reject recursive schemas in strict mode, and for the same reason there are no length
// or count limits; the prompt carries those.
const schema = {
	type: 'object',
	properties: {
		product: { type: 'string' },
		areas: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					flows: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' },
								continues_from: { type: 'string' },
								title: { type: 'string' },
								goal: { type: 'string' },
								start: { type: 'string' },
								needs_login: { type: 'boolean' },
								needs_payment_or_private_data: { type: 'boolean' },
								success: { type: 'string' }
							},
							required: [
								'id',
								'continues_from',
								'title',
								'goal',
								'start',
								'needs_login',
								'needs_payment_or_private_data',
								'success'
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

interface PlannedFlow {
	id: string;
	continues_from: string;
	title: string;
	goal: string;
	start: string;
	needs_login: boolean;
	needs_payment_or_private_data: boolean;
	success: string;
}

interface Plan {
	product: string;
	areas: { name: string; flows: PlannedFlow[] }[];
}

// --- judging a plan -----------------------------------------------------------------------------

/** Cheap signals of a plan's quality, next to its cost. Reading the plans is still the real test. */
interface PlanStats {
	flows: number;
	areas: number;
	/** Flows that continue from another one, the way Mobbin nests flows. */
	chained: number;
	/** The longest chain, counting the flow it starts from. */
	deepestChain: number;
	/** Flows that continue from an id the plan does not have, which a crawl cannot run. */
	brokenChains: number;
	needsLogin: number;
	/** Flows the model itself flagged as needing payment or personal data, which a crawl drops. */
	flaggedPrivate: number;
	/** Titles that appear more than once, compared without case and punctuation. */
	duplicateTitles: number;
	/** Flows starting at a URL whose path the landing page links to, so it surely exists. */
	startsLinkedFromPage: number;
	/** Flows starting at a URL, the others continue from another flow. */
	startsAtUrl: number;
	/** Starts that are neither a path nor a URL, like "New arrivals". */
	invalidStarts: number;
}

/** Answers without a JSON schema behind them sometimes come wrapped in a Markdown code block. */
function parsePlan(content: string): Plan {
	const unwrapped = content
		.trim()
		.replace(/^```(?:json)?\s*/, '')
		.replace(/\s*```$/, '');
	return JSON.parse(unwrapped) as Plan;
}

/** Compares titles and paths without case, punctuation or a trailing slash. */
function normalizedText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function normalizedPath(url: URL): string {
	return url.pathname.replace(/\/$/, '') || '/';
}

function statsOf(plan: Plan): PlanStats {
	const flows = plan.areas.flatMap((area) => area.flows);
	const flowsById = new Map(flows.map((flow) => [flow.id, flow]));
	const linkedPaths = new Set(
		snapshot.clickables
			.filter((clickable) => clickable.href !== undefined)
			.map((clickable) => new URL(clickable.href!))
			.filter((target) => bareHost(target.hostname) === host)
			.map(normalizedPath)
	);

	/** How many flows the agent runs to reach the end of this one; cycles count as broken. */
	function chainLength(flow: PlannedFlow): number {
		let length = 1;
		const visited = new Set([flow.id]);
		let parent = flowsById.get(flow.continues_from);
		while (parent !== undefined && !visited.has(parent.id)) {
			visited.add(parent.id);
			length++;
			parent = flowsById.get(parent.continues_from);
		}
		return length;
	}

	const rootFlows = flows.filter((flow) => flow.continues_from === '');
	const titleKeys = flows.map((flow) => normalizedText(flow.title));
	return {
		flows: flows.length,
		areas: plan.areas.length,
		chained: flows.length - rootFlows.length,
		deepestChain: Math.max(0, ...flows.map(chainLength)),
		brokenChains: flows.filter(
			(flow) => flow.continues_from !== '' && !flowsById.has(flow.continues_from)
		).length,
		needsLogin: flows.filter((flow) => flow.needs_login).length,
		flaggedPrivate: flows.filter((flow) => flow.needs_payment_or_private_data).length,
		duplicateTitles: titleKeys.length - new Set(titleKeys).size,
		startsLinkedFromPage: rootFlows.filter(
			(flow) =>
				flow.start.startsWith('/') && linkedPaths.has(normalizedPath(new URL(flow.start, snapshot.url)))
		).length,
		startsAtUrl: rootFlows.length,
		invalidStarts: rootFlows.filter((flow) => !/^(\/|https?:\/\/)\S*$/.test(flow.start)).length
	};
}

// --- running the model --------------------------------------------------------------------------

const { uri } = await imageDataUri(screenshot, IMAGE_MAX_SIDE);
// The whole spec, provider included, so runs of one model on different providers stay apart.
const modelName =
	values['dry-run'] || values.model === undefined ? 'dry-run' : values.model.replace(/[/@]/g, '_');
const runDirectory = join(
	siteDirectory,
	`${new Date().toISOString().replace(/[:.]/g, '-')}-plan-${modelName}`
);
await mkdir(runDirectory, { recursive: true });
await writeFile(join(runDirectory, 'prompt.txt'), prompt);
if (values['dry-run'] || benchModel === undefined) {
	// For checking the prompt and the element list before any money is spent.
	console.log(`prompt written to ${join(runDirectory, 'prompt.txt')}, no model was called`);
	process.exit(0);
}

let upstreamText = '';
if (upstream !== undefined) {
	upstreamText = ` on ${upstream.provider}`;
	if (upstream.quantization !== undefined) upstreamText += ` in ${upstream.quantization}`;
}
console.log(
	`planning ${host} with ${benchModel.id}${upstreamText}, reasoning ${reasoning}, up to ${maxTokens} output tokens`
);
const call = await callModel(benchModel, {
	content: [
		{ type: 'image_url', image_url: { url: uri } },
		{ type: 'text', text: prompt }
	],
	schema: { name: 'flow_plan', schema },
	maxTokens,
	reasoning,
	upstream
});
let plan: Plan | undefined;
let stats: PlanStats | undefined;
/** Why there is no plan: the call failed, or the answer was cut off or not valid JSON. */
let failure = call.error;
if (failure === undefined) {
	try {
		plan = parsePlan(call.content);
		stats = statsOf(plan);
	} catch (error) {
		// A plan cut off by the token limit, or an answer that ignored the schema.
		failure = `The answer is not a plan (finish reason ${call.finishReason}): ${(error as Error).message}`;
	}
}
await writeFile(
	join(runDirectory, 'result.json'),
	JSON.stringify({ model: benchModel, upstream, reasoning, call, plan, stats, failure }, null, '\t')
);
console.log(
	`${failure ?? `${stats!.flows} flows`}, $${call.cost.toFixed(4)}, ${call.seconds.toFixed(1)} s`
);

// --- the report ---------------------------------------------------------------------------------

/**
 * Three significant digits, because the amounts span from fractions of a cent per flow to dollars
 * per million tokens, and fixed decimals either show $0.0000 or floating-point noise.
 */
function dollars(amount: number): string {
	return `$${Number(amount.toPrecision(3))}`;
}

const costPerFlow = stats !== undefined && stats.flows > 0 ? dollars(call.cost / stats.flows) : '';
const costNote = call.costIsReported ? '' : ' (est.)';
const { input: inputPrice, output: outputPrice } = benchModel.pricePerMillion;
const TABLE_HEADER = `| Run | Model | Provider | Reasoning | Price | Flows | Areas | Chained | Broken | Login | Linked | Duplicates | Input | Output | Reasoning tokens | Cost | Per flow | Seconds | Finish |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`;
const tableRow = `| ${[
	runDirectory.split('/').at(-1),
	benchModel.id,
	`${call.servedBy ?? upstream?.provider ?? ''}${upstream?.quantization === undefined ? '' : ` (${upstream.quantization})`}`,
	reasoning,
	`${dollars(inputPrice)} / ${dollars(outputPrice)}`,
	stats?.flows ?? '',
	stats?.areas ?? '',
	stats === undefined ? '' : `${stats.chained} (${stats.deepestChain} deep)`,
	stats?.brokenChains ?? '',
	stats?.needsLogin ?? '',
	stats === undefined ? '' : `${stats.startsLinkedFromPage}/${stats.startsAtUrl}`,
	stats?.duplicateTitles ?? '',
	call.inputTokens,
	call.outputTokens,
	call.reasoningTokens,
	`${dollars(call.cost)}${costNote}`,
	costPerFlow,
	call.firstTokenSeconds === undefined
		? call.seconds.toFixed(1)
		: `${call.seconds.toFixed(1)} (${call.firstTokenSeconds.toFixed(1)})`,
	failure === undefined ? call.finishReason : 'failed'
].join(' | ')} |`;

/**
 * A plan as a tree, the way Mobbin lists flows: every flow under its area, and a flow that
 * continues from another indented under it. A flow whose parent is missing is shown at the top
 * level of its area, marked, so a broken chain is visible.
 */
function planAsTree(plan: Plan): string {
	const flows = plan.areas.flatMap((area) => area.flows);
	const ids = new Set(flows.map((flow) => flow.id));
	const childrenById = new Map<string, PlannedFlow[]>();
	for (const flow of flows) {
		if (!ids.has(flow.continues_from)) continue;
		childrenById.set(flow.continues_from, [...(childrenById.get(flow.continues_from) ?? []), flow]);
	}

	function lines(flow: PlannedFlow, depth: number, visited: Set<string>): string[] {
		const flags = [
			flow.needs_login ? 'login' : '',
			flow.needs_payment_or_private_data ? 'private data' : '',
			flow.continues_from !== '' && !ids.has(flow.continues_from)
				? `continues from missing ${flow.continues_from}`
				: ''
		].filter((flag) => flag !== '');
		const flagText = flags.length > 0 ? ` (${flags.join(', ')})` : '';
		const startText = flow.continues_from === '' ? ` Starts at \`${flow.start}\`.` : '';
		const line = `${'  '.repeat(depth)}- **${flow.title}**${flagText}: ${flow.goal}.${startText} Done when: ${flow.success}`;
		// A chain that loops back on itself is shown once, not forever.
		if (visited.has(flow.id)) return [line];
		const children = childrenById.get(flow.id) ?? [];
		return [
			line,
			...children.flatMap((child) => lines(child, depth + 1, new Set([...visited, flow.id])))
		];
	}

	const areas = plan.areas.map((area) => {
		const topLevel = area.flows.filter((flow) => !ids.has(flow.continues_from));
		const areaLines = topLevel.flatMap((flow) => lines(flow, 0, new Set()));
		return `#### ${area.name}\n\n${areaLines.join('\n')}`;
	});
	return `${plan.product}\n\n${areas.join('\n\n')}`;
}

/** Mobbin's flows for the site, written down by hand, to read the plan against. */
let reference = '';
try {
	reference = await readFile(join(import.meta.dirname, 'reference', `${siteSlug}.md`), 'utf8');
} catch (error) {
	// Most sites have no reference list, which is fine: the summary then only has the plan.
	if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const TABLE_NOTES = `"Price" is the list price per million input and output tokens. "Chained" counts flows that continue from another flow, and how long the longest chain is. "Broken" counts flows that continue from an id the plan does not have. "Linked" counts flows starting at a URL whose path the landing page links to, so it surely exists, out of all flows that start at a URL. Output tokens include the reasoning tokens. "Seconds" is the whole call, with the wait for the first token in brackets. A cost marked (est.) is computed from list prices because the provider did not report it.`;

const summary = `# Planning ${host} with ${benchModel.id}

Snapshot of ${snapshot.url} taken ${snapshot.takenAt}, with ${snapshot.clickables.length} clickable elements. Reasoning ${reasoning}, up to ${maxTokens} output tokens. The prompt is in \`prompt.txt\`, the raw answer in \`result.json\`.

${TABLE_NOTES}

${TABLE_HEADER}
${tableRow}
${failure === undefined ? '' : `\n## Failure\n\n${failure.slice(0, 2000)}\n`}${reference === '' ? '' : `\n## Mobbin's flows for this site\n\n${reference.trim()}\n`}
## Plan

${plan === undefined ? 'No plan.' : planAsTree(plan)}
`;
await writeFile(join(runDirectory, 'summary.md'), summary);
console.log(`summary: ${join(runDirectory, 'summary.md')}`);

// Every run of the site adds its row here, so all models tried end up in one table. The header
// is written by the first run.
const resultsPath = join(siteDirectory, 'plan-results.md');
try {
	await writeFile(resultsPath, `# Planning ${host}, all runs\n\n${TABLE_NOTES}\n\n${TABLE_HEADER}\n`, {
		flag: 'wx'
	});
} catch (error) {
	// The table already exists from an earlier run, which is the usual case.
	if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}
await appendFile(resultsPath, `${tableRow}\n`);
console.log(`all runs: ${resultsPath}`);
