// Flows that people ask for (the `flow_request` table). The worker picks them up between crawls and
// tries each goal inside the site's current crawl for the viewport, so the screens and the flow show
// up with the rest of the site, and enriches the crawl afterwards.
import type { Surreal } from 'surrealdb';
import { chat, modelConfigFromEnv } from '#lib/server/models.ts';
import { sourceCrawls } from '#lib/server/library.ts';
import { RecordId } from '#lib/server/surreal.ts';
import {
	FLOW_CATEGORIES,
	FLOW_CATEGORY_DESCRIPTIONS,
	type FlowCategory,
	type Viewport
} from '#lib/types.ts';
import { loadAccount } from './accounts.ts';
import { closeBrowser, launchBrowser } from './capture.ts';
import { CrawlCancelled, createCrawlContext } from './crawl.ts';
import { enrichCrawl } from './enrich.ts';
import { attemptFlow } from './explore.ts';
import type { PlannedFlow } from './goals.ts';
import type { CrawlJob } from './jobs.ts';
import { clearLiveGoals } from './live.ts';
import { ScreenIndex } from './trajectory.ts';

const models = modelConfigFromEnv(process.env);

export interface FlowRequestJob {
	id: RecordId;
	site: RecordId;
	viewport: Viewport;
	goal: string;
}

/** Creates a request exactly as the UI does. */
export async function queueFlowRequest(
	db: Surreal,
	site: RecordId,
	viewport: Viewport,
	goal: string
): Promise<FlowRequestJob> {
	const [created] = await db
		.query('CREATE ONLY flow_request CONTENT { site: $site, viewport: $viewport, goal: $goal }', {
			site,
			viewport,
			goal
		})
		.collect<[FlowRequestJob]>();
	return created;
}

/** Requests left 'running' by a worker that died go back in the queue. */
export async function requeueStuckRequests(db: Surreal): Promise<number> {
	const [reset] = await db
		.query("UPDATE flow_request SET status = 'queued' WHERE status = 'running' RETURN id")
		.collect<[unknown[]]>();
	return reset.length;
}

/**
 * Claims a specific queued request. The status check in the UPDATE makes the claim atomic: if
 * another worker got there first, the UPDATE matches nothing and we return undefined.
 */
export async function claimFlowRequest(
	db: Surreal,
	requestId: RecordId
): Promise<FlowRequestJob | undefined> {
	const [claimed] = await db
		.query(
			`UPDATE $id SET status = 'running', started_at = time::now(), finished_at = NONE, error = NONE
				WHERE status = 'queued'`,
			{ id: requestId }
		)
		.collect<[FlowRequestJob[]]>();
	return claimed[0];
}

/** Claims the oldest queued request, if any. */
export async function claimNextFlowRequest(db: Surreal): Promise<FlowRequestJob | undefined> {
	const [oldest] = await db
		.query(
			"SELECT id, created_at FROM flow_request WHERE status = 'queued' ORDER BY created_at LIMIT 1"
		)
		.collect<[{ id: RecordId }[]]>();
	return oldest.length === 0 ? undefined : claimFlowRequest(db, oldest[0].id);
}

/**
 * Runs a claimed request and records the outcome on it: the flow it produced, or the error. A
 * shutdown puts the request back in the queue instead.
 */
export async function executeFlowRequest(
	db: Surreal,
	request: FlowRequestJob,
	signal: AbortSignal
): Promise<void> {
	let crawlId: RecordId;
	try {
		const result = await runFlowRequest(db, request, signal);
		crawlId = result.crawl;
		await db
			.query(
				'UPDATE $id SET status = $status, flow = $flow, error = $error, finished_at = time::now()',
				{
					id: request.id,
					status: result.error === undefined ? 'done' : 'failed',
					flow: result.flow === undefined ? undefined : new RecordId('flow', result.flow),
					error: result.error
				}
			)
			.collect();
	} catch (error) {
		if (error instanceof CrawlCancelled) {
			await db
				.query("UPDATE $id SET status = 'queued', started_at = NONE", { id: request.id })
				.collect();
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(`flow request ${request.id.id} failed: ${message}`);
		await db
			.query("UPDATE $id SET status = 'failed', error = $error, finished_at = time::now()", {
				id: request.id,
				error: message
			})
			.collect();
		return;
	}
	// The new screens and the flow get their descriptions. The request is already done, so a model
	// that is down only delays them until the next `bun run enrich`.
	try {
		await enrichCrawl(db, crawlId);
	} catch (error) {
		console.warn(`enrichment skipped: ${error instanceof Error ? error.message : error}`);
	}
}

/** Tries the goal of a request. Returns the flow it saved, or why there is none. */
async function runFlowRequest(
	db: Surreal,
	request: FlowRequestJob,
	signal: AbortSignal
): Promise<{ crawl: RecordId; flow?: string; error?: string }> {
	const siteSlug = String(request.site.id);
	const source = (await sourceCrawls(db, siteSlug)).find(
		(crawl) => crawl.viewport === request.viewport
	);
	if (source === undefined) {
		throw new Error(
			`${siteSlug} has not been explored on ${request.viewport} yet, so there is no crawl to add the flow to. Crawl the site first.`
		);
	}
	const crawlId = new RecordId('crawl', source.id);
	const [jobs] = await db.query('SELECT * FROM $id', { id: crawlId }).collect<[CrawlJob[]]>();
	const ctx = await createCrawlContext(db, jobs[0], signal);

	const account = await loadAccount(db, siteSlug);
	const accountIsUsable = account?.status === 'active' && account.storage_state !== undefined;
	const { category, needsLogin } = await classifyRequest(
		ctx.site.name,
		ctx.site.host,
		request.goal
	);
	const flow: PlannedFlow = {
		goal: request.goal,
		category,
		area: 'Requested',
		startUrl: ctx.site.url,
		success: '',
		signedIn: accountIsUsable && needsLogin
	};

	const screenIndex = await ScreenIndex.load(db, crawlId);
	const browser = await launchBrowser();
	try {
		const { report, flowId } = await attemptFlow(browser, ctx, screenIndex, flow, {
			source: 'request',
			goalNumber: 1,
			slot: 0,
			account: accountIsUsable ? account : undefined,
			establishesLogin: false
		});
		if (flowId !== undefined) return { crawl: crawlId, flow: flowId };
		const notice =
			needsLogin && !accountIsUsable
				? ' The goal needs a login, and the site has no demo account that works.'
				: '';
		return {
			crawl: crawlId,
			error: `No flow was saved: ${report.notSaved ?? 'the run ended'} (${report.outcome}: ${report.reason}).${notice}`
		};
	} finally {
		await closeBrowser(browser);
		await clearLiveGoals(db, crawlId);
	}
}

/**
 * Has the model file a requested goal under a category, and judge whether it needs the demo
 * account's login. Both are answered from the sentence alone, which is all a request has.
 */
async function classifyRequest(
	siteName: string,
	host: string,
	goal: string
): Promise<{ category: FlowCategory; needsLogin: boolean }> {
	const categoryLines = FLOW_CATEGORIES.map(
		(category) => `- ${category}: ${FLOW_CATEGORY_DESCRIPTIONS[category]}`
	).join('\n');
	const answer = await chat(
		models.vlm,
		[
			{
				role: 'user',
				content:
					`Someone asked for this flow on the website ${siteName} (${host}) to be recorded: "${goal}"\n\n` +
					'category: what the flow is about. Allowed categories:\n' +
					`${categoryLines}\n` +
					'needs_login: true when the flow can only be done signed in to an account, like ' +
					'using a dashboard, a settings page or a product that is behind a login, and false ' +
					'when a visitor without an account can do it.'
			}
		],
		{
			schema: {
				name: 'request_classification',
				schema: {
					type: 'object',
					properties: {
						category: { type: 'string', enum: FLOW_CATEGORIES },
						needs_login: { type: 'boolean' }
					},
					required: ['category', 'needs_login'],
					additionalProperties: false
				}
			},
			maxTokens: 60
		}
	);
	const parsed = JSON.parse(answer) as { category: FlowCategory; needs_login: boolean };
	return { category: parsed.category, needsLogin: parsed.needs_login };
}
