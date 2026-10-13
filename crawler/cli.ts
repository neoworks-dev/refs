// `bun run crawl <url> [--viewport desktop|mobile|both] [--max-screens N] [--max-depth N] [--max-trajectories N]`
// Creates the site and crawl(s) the same way the UI does, then runs them inline without the worker.
import { parseArgs } from 'node:util';
import { configFromEnv, connect } from '#lib/server/surreal.ts';
import { VIEWPORTS, type Viewport } from '#lib/types.ts';
import { executeCrawl } from './crawl.ts';
import { claimCrawl, ensureSite, queueCrawl } from './jobs.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		viewport: { type: 'string', default: 'desktop' },
		'max-screens': { type: 'string' },
		'max-depth': { type: 'string' },
		'max-trajectories': { type: 'string' }
	}
});

function fail(message: string): never {
	console.error(message);
	console.error(
		'usage: bun run crawl <url> [--viewport desktop|mobile|both] [--max-screens N] [--max-depth N] [--max-trajectories N]'
	);
	process.exit(2);
}

function parseLimit(name: string, raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) fail(`--${name} must be a non-negative integer`);
	return value;
}

if (positionals.length !== 1) fail('expected exactly one URL');
if (!['desktop', 'mobile', 'both'].includes(values.viewport))
	fail('--viewport must be desktop, mobile or both');
const viewports: Viewport[] =
	values.viewport === 'both' ? VIEWPORTS : [values.viewport as Viewport];
const limits = {
	maxScreens: parseLimit('max-screens', values['max-screens']),
	maxDepth: parseLimit('max-depth', values['max-depth']),
	maxTrajectories: parseLimit('max-trajectories', values['max-trajectories'])
};

const shutdown = new AbortController();
process.on('SIGINT', () => shutdown.abort());
process.on('SIGTERM', () => shutdown.abort());

const db = await connect(configFromEnv(process.env));
const site = await ensureSite(db, positionals[0]);
for (const viewport of viewports) {
	const queued = await queueCrawl(db, site, viewport, limits);

	// Claim only our own crawl; other queued crawls belong to the worker.
	const job = await claimCrawl(db, queued.id);
	if (!job) fail(`crawl ${queued.id.id} was claimed by another worker`);

	await executeCrawl(db, job, shutdown.signal, 'fail');
	const [counts] = await db
		.query('SELECT status, screens, elements, error FROM $id', { id: job.id })
		.collect<[{ status: string; screens: number; elements: number; error?: string }[]]>();
	console.log(`${site.host} ${viewport}: ${JSON.stringify(counts[0])}`);
}
await db.close();
// A browser that failed to close in time would otherwise keep the process alive.
process.exit(0);
