// Sites and crawl jobs in SurrealDB: creating them (exactly as the UI does), claiming queued
// crawls, finishing them, and cleaning up after an interrupted run.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Surreal } from 'surrealdb';
import { RecordId } from '#lib/server/surreal.ts';
import type { Viewport } from '#lib/types.ts';
import { bareHost, normalizeUrl, parseInputUrl, slugFromHost } from './rules.ts';

export interface SiteRow {
	id: RecordId;
	name: string;
	slug: string;
	url: string;
	host: string;
	description?: string;
	icon?: string;
}

export interface CrawlJob {
	id: RecordId;
	site: RecordId;
	viewport: Viewport;
	max_screens: number;
	max_depth: number;
}

export const DEFAULT_MAX_SCREENS = 30;
export const DEFAULT_MAX_DEPTH = 3;

/**
 * Finds the site for a URL or creates it. One site per host, where `www.` doesn't count; the record
 * id is the slug (`site:linear-app`) and a new site is named after its host until the crawl learns better.
 */
export async function ensureSite(db: Surreal, input: string): Promise<SiteRow> {
	const parsed = parseInputUrl(input);
	const url = parsed && normalizeUrl(parsed);
	if (!parsed || !url) throw new Error(`not a valid http(s) URL: ${input}`);

	const host = bareHost(parsed.hostname);
	const [existing] = await db.query('SELECT * FROM site WHERE host = $host', { host }).collect<[SiteRow[]]>();
	if (existing.length > 0) return existing[0];

	const slug = slugFromHost(host);
	const [created] = await db
		.query('CREATE ONLY $id CONTENT $content', {
			id: new RecordId('site', slug),
			content: { name: host, slug, url, host }
		})
		.collect<[SiteRow]>();
	return created;
}

export async function queueCrawl(
	db: Surreal,
	site: SiteRow,
	viewport: Viewport,
	limits: { maxScreens?: number; maxDepth?: number } = {}
): Promise<CrawlJob> {
	const [created] = await db
		.query('CREATE ONLY crawl CONTENT $content', {
			content: {
				site: site.id,
				viewport,
				max_screens: limits.maxScreens ?? DEFAULT_MAX_SCREENS,
				max_depth: limits.maxDepth ?? DEFAULT_MAX_DEPTH
			}
		})
		.collect<[CrawlJob]>();
	return created;
}

/** Crawls left 'running' by a worker that died go back in the queue. */
export async function requeueStuckCrawls(db: Surreal): Promise<number> {
	const [reset] = await db
		.query("UPDATE crawl SET status = 'queued' WHERE status = 'running' RETURN id")
		.collect<[unknown[]]>();
	return reset.length;
}

/**
 * Claims a specific queued crawl. The status check in the UPDATE makes the claim atomic: if another
 * worker (or a UI cancel) got there first, the UPDATE matches nothing and we return undefined.
 */
export async function claimCrawl(db: Surreal, crawlId: RecordId): Promise<CrawlJob | undefined> {
	const [claimed] = await db
		.query(
			`UPDATE $id SET status = 'running', started_at = time::now(), finished_at = NONE, error = NONE,
				activity = NONE WHERE status = 'queued'`,
			{ id: crawlId }
		)
		.collect<[CrawlJob[]]>();
	return claimed[0];
}

/** Claims the oldest queued crawl, if any. */
export async function claimNextCrawl(db: Surreal): Promise<CrawlJob | undefined> {
	const [oldest] = await db
		.query("SELECT id, created_at FROM crawl WHERE status = 'queued' ORDER BY created_at LIMIT 1")
		.collect<[{ id: RecordId }[]]>();
	return oldest.length === 0 ? undefined : claimCrawl(db, oldest[0].id);
}

export async function getCrawlStatus(db: Surreal, crawlId: RecordId): Promise<string | undefined> {
	const [statuses] = await db.query('SELECT VALUE status FROM $id', { id: crawlId }).collect<[string[]]>();
	return statuses[0];
}

export async function finishCrawl(db: Surreal, crawlId: RecordId, outcome: { error?: string }): Promise<void> {
	await db
		.query(
			`UPDATE $id SET status = $status, error = $error, finished_at = time::now()
				WHERE status = 'running'`,
			{ id: crawlId, status: outcome.error === undefined ? 'done' : 'failed', error: outcome.error }
		)
		.collect();
}

/** Puts a crawl that was interrupted by a shutdown back in the queue. */
export async function requeueCrawl(db: Surreal, crawlId: RecordId): Promise<void> {
	await db.query("UPDATE $id SET status = 'queued', activity = NONE WHERE status = 'running'", { id: crawlId }).collect();
}

/**
 * Deletes whatever an earlier, interrupted run of this crawl captured, so that re-running it
 * doesn't leave duplicate screens behind. Media directories are removed too.
 */
export async function purgeCrawlData(db: Surreal, mediaRoot: string, job: CrawlJob): Promise<void> {
	const [screens] = await db.query('SELECT id FROM screen WHERE crawl = $crawl', { crawl: job.id }).collect<[{ id: RecordId }[]]>();
	if (screens.length === 0) return;

	for (const screen of screens) {
		await rm(join(mediaRoot, 'sites', String(job.site.id), job.viewport, String(screen.id.id)), {
			recursive: true,
			force: true
		});
	}
	await db
		.query(
			`DELETE element WHERE screen IN (SELECT VALUE id FROM screen WHERE crawl = $crawl);
			DELETE action WHERE crawl = $crawl;
			DELETE screen WHERE crawl = $crawl;
			UPDATE $crawl SET screens = 0, elements = 0`,
			{ crawl: job.id }
		)
		.collect();
}

/** A crawl cancelled from the UI keeps its status; this only stamps when it actually stopped. */
export async function stampFinished(db: Surreal, crawlId: RecordId): Promise<void> {
	await db.query('UPDATE $id SET finished_at = time::now()', { id: crawlId }).collect();
}
