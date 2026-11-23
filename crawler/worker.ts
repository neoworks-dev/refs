// Long-running crawl worker: polls for queued crawls and flow requests, runs them one at a time.
// Crawls go first, because a request is added to a site's crawl and is only worth more once it exists.
import { setTimeout as sleep } from 'node:timers/promises';
import { configFromEnv, connect } from '#lib/server/surreal.ts';
import { executeCrawl } from './crawl.ts';
import { claimNextCrawl, requeueStuckCrawls } from './jobs.ts';
import { claimNextFlowRequest, executeFlowRequest, requeueStuckRequests } from './requests.ts';

const POLL_INTERVAL_MS = 2000;

const shutdown = new AbortController();
const stop = (signalName: string) => {
	if (shutdown.signal.aborted) process.exit(1);
	console.log(
		`${signalName} received, stopping after cleaning up the current crawl (again to force)`
	);
	shutdown.abort();
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

const db = await connect(configFromEnv(process.env));
const stuck = await requeueStuckCrawls(db);
if (stuck > 0) console.log(`re-queued ${stuck} crawl(s) left running by a previous worker`);
const stuckRequests = await requeueStuckRequests(db);
if (stuckRequests > 0)
	console.log(`re-queued ${stuckRequests} flow request(s) left running by a previous worker`);
console.log('crawler worker ready');

while (!shutdown.signal.aborted) {
	const job = await claimNextCrawl(db);
	if (job) {
		console.log(`crawl ${job.id.id} (${job.site.id}, ${job.viewport}) started`);
		await executeCrawl(db, job, shutdown.signal, 'requeue');
		console.log(`crawl ${job.id.id} finished`);
		continue;
	}
	const request = await claimNextFlowRequest(db);
	if (request) {
		console.log(`flow request ${request.id.id} (${request.site.id}, ${request.viewport}) started`);
		await executeFlowRequest(db, request, shutdown.signal);
		console.log(`flow request ${request.id.id} finished`);
		continue;
	}
	await sleep(POLL_INTERVAL_MS);
}

await db.close();
// A browser that failed to close in time would otherwise keep the process alive.
process.exit(0);
