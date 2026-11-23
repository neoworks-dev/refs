// `bun run crawl <url> [--viewport desktop|mobile|both] [--max-trajectories N] [--plan-only]`
// Creates the site and crawl(s) the same way the UI does, then runs them inline without the worker.
// With --plan-only it only prints the flows the model would plan from the landing page, without
// touching the database, which is how the planning prompt is tried out.
//
// `bun run request <site> "<goal>" [--viewport desktop|mobile|both] [--queue]`
// Asks for one flow on a site that has been crawled, as the UI does, and runs it inline. With
// --queue it only queues the request, for the worker.
//
// `bun run login <site>`
// Opens a plain Chrome on the site for a person to sign up or log in to its demo account, for
// sites whose bot protection stops the crawler's own sign-up, and saves the login for the crawls.
import { parseArgs } from 'node:util';
import { configFromEnv, connect } from '#lib/server/surreal.ts';
import { VIEWPORTS, type Viewport } from '#lib/types.ts';
import {
	closeBrowser,
	launchBrowser,
	loadPage,
	openContext,
	viewportScreenshot
} from './capture.ts';
import { executeCrawl } from './crawl.ts';
import { planFlows, readLandingPage } from './goals.ts';
import { manualLogin } from './login.ts';
import { claimCrawl, ensureSite, queueCrawl, type SiteRow } from './jobs.ts';
import { claimFlowRequest, executeFlowRequest, queueFlowRequest } from './requests.ts';
import { bareHost, normalizeUrl, parseInputUrl } from './rules.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		viewport: { type: 'string', default: 'desktop' },
		'max-trajectories': { type: 'string' },
		'plan-only': { type: 'boolean' },
		queue: { type: 'boolean' }
	}
});

const USAGE = `usage: bun run crawl <url> [--viewport desktop|mobile|both] [--max-trajectories N] [--plan-only]
       bun run request <site> "<goal>" [--viewport desktop|mobile|both] [--queue]
       bun run login <site>`;

function fail(message: string): never {
	console.error(message);
	console.error(USAGE);
	process.exit(2);
}

if (!['desktop', 'mobile', 'both'].includes(values.viewport))
	fail('--viewport must be desktop, mobile or both');
const viewports: Viewport[] =
	values.viewport === 'both' ? VIEWPORTS : [values.viewport as Viewport];

const shutdown = new AbortController();
process.on('SIGINT', () => shutdown.abort());
process.on('SIGTERM', () => shutdown.abort());

const db = await connect(configFromEnv(process.env));
if (positionals[0] === 'request') {
	await requestFlow();
} else if (positionals[0] === 'login') {
	if (positionals.length !== 2) fail('expected a site');
	await manualLogin(db, positionals[1], shutdown.signal);
} else if (values['plan-only']) {
	await printPlan();
} else {
	await crawl();
}
await db.close();
// A browser that failed to close in time would otherwise keep the process alive.
process.exit(0);

async function crawl(): Promise<void> {
	if (positionals.length !== 1) fail('expected exactly one URL');
	let maxTrajectories: number | undefined;
	if (values['max-trajectories'] !== undefined) {
		maxTrajectories = Number(values['max-trajectories']);
		if (!Number.isInteger(maxTrajectories) || maxTrajectories < 0)
			fail('--max-trajectories must be a non-negative integer');
	}

	const site = await ensureSite(db, positionals[0]);
	for (const viewport of viewports) {
		const queued = await queueCrawl(db, site, viewport, { maxTrajectories });

		// Claim only our own crawl; other queued crawls belong to the worker.
		const job = await claimCrawl(db, queued.id);
		if (!job) fail(`crawl ${queued.id.id} was claimed by another worker`);

		await executeCrawl(db, job, shutdown.signal, 'fail');
		const [counts] = await db
			.query('SELECT status, screens, elements, error FROM $id', { id: job.id })
			.collect<[{ status: string; screens: number; elements: number; error?: string }[]]>();
		console.log(`${site.host} ${viewport}: ${JSON.stringify(counts[0])}`);
	}
}

/** Prints the plan for a site's landing page without saving anything. */
async function printPlan(): Promise<void> {
	if (positionals.length !== 1) fail('expected exactly one URL');
	const parsed = parseInputUrl(positionals[0]);
	const url = parsed && normalizeUrl(parsed);
	if (!parsed || !url) fail(`not a valid http(s) URL: ${positionals[0]}`);
	const host = bareHost(parsed.hostname);

	const browser = await launchBrowser();
	try {
		for (const viewport of viewports) {
			const { context } = await openContext(browser, viewport);
			try {
				const page = await context.newPage();
				await loadPage(page, url, { waitForBanner: true });
				const flows = await planFlows({
					siteName: host,
					siteUrl: url,
					host,
					viewport,
					image: await viewportScreenshot(page),
					page: await readLandingPage(page, host),
					hasAccount: false,
					signedIn: false
				});
				console.log(`${host} ${viewport}: ${flows.length} flows planned`);
				for (const flow of flows) {
					console.log(`  [${flow.category}] ${flow.area}: ${flow.goal} (from ${flow.startUrl})`);
					console.log(`      done when: ${flow.success}`);
				}
			} finally {
				await closeBrowser(context);
			}
		}
	} finally {
		await closeBrowser(browser);
	}
}

async function requestFlow(): Promise<void> {
	if (positionals.length !== 3) fail('expected a site and a goal');
	const [, siteName, goal] = positionals;
	const [sites] = await db
		.query('SELECT * FROM site WHERE slug = $name OR host = $name', {
			name: bareHost(siteName)
		})
		.collect<[SiteRow[]]>();
	if (sites.length === 0) fail(`There is no site "${siteName}". Crawl it first.`);

	for (const viewport of viewports) {
		const queued = await queueFlowRequest(db, sites[0].id, viewport, goal);
		if (values.queue) {
			console.log(`${sites[0].host} ${viewport}: queued request ${queued.id.id}`);
			continue;
		}
		// Claim only our own request; other queued requests belong to the worker.
		const request = await claimFlowRequest(db, queued.id);
		if (!request) fail(`request ${queued.id.id} was claimed by another worker`);

		await executeFlowRequest(db, request, shutdown.signal);
		const [results] = await db
			.query('SELECT status, flow, error FROM $id', { id: request.id })
			.collect<[{ status: string; flow?: unknown; error?: string }[]]>();
		console.log(`${sites[0].host} ${viewport}: ${JSON.stringify(results[0])}`);
	}
}
