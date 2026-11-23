// Runs the captured screens and section crops of a crawl through the models: page type and
// description per screen, a label per section, an embedding for both, and a category, title and
// step captions per flow. Resumable, because every pass only picks up what has no result yet, so it
// backfills crawls from before the models existed and carries on where an interrupted run stopped.
// The prompts are in describe.ts.
//
// `bun crawler/enrich.ts [site-slug]` enriches the current crawls of one site, or of every site.
import type { Surreal } from 'surrealdb';
import { localMedia, type MediaStore } from '#lib/server/media.ts';
import { embed, ModelError, modelConfigFromEnv } from '#lib/server/models.ts';
import { configFromEnv, connect, RecordId } from '#lib/server/surreal.ts';
import { sourceCrawls } from '#lib/server/library.ts';
import type { FlowCategory } from '#lib/types.ts';
import { classifyScreen, labelElement, MAX_FLOW_STEPS, nameFlow } from './describe.ts';

/** A server that is up answers a trivial request at once; this only bounds the wait on a dead one. */
const REACHABLE_TIMEOUT_MS = 3000;

/** How many items pass between two progress lines of a long run. */
const PROGRESS_INTERVAL = 25;

/**
 * One item can't be enriched right now: the model refused its image, or the file isn't there yet
 * because a running crawl records a screen before its media is written. The run goes on and the
 * next run tries the item again.
 */
export class ItemSkipped extends Error {}

interface ScreenToEnrich {
	id: RecordId;
	url: string;
	title: string;
	image: string;
}

interface FlowToName {
	id: RecordId;
	/** Set on goal flows, which are born with a category and a title that naming must keep. */
	category?: FlowCategory;
	/** The steps as stored, so naming only adds captions and leaves screens and actions alone. */
	steps: { screen: RecordId; action?: RecordId; caption?: string; thought?: string }[];
	urls: string[];
	images: string[];
	/** Label of the click that led to each step; the first step has none. */
	labels: (string | undefined)[];
}

interface SectionToEnrich {
	id: RecordId;
	image: string;
}

/** Whether the model server answers at all, so callers can skip model work instead of failing. */
export async function isModelServiceReachable(): Promise<boolean> {
	const { vlm } = modelConfigFromEnv(process.env);
	try {
		const response = await fetch(`${vlm.url}/models`, {
			headers: vlm.apiKey === undefined ? {} : { authorization: `Bearer ${vlm.apiKey}` },
			signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS)
		});
		return response.ok;
	} catch (error) {
		// A refused connection or a timeout is the answer "not reachable"; anything else is a bug.
		if (
			error instanceof TypeError ||
			(error instanceof DOMException && error.name === 'TimeoutError')
		)
			return false;
		throw error;
	}
}

/** Runs one pass over `items`. An image the model refuses or fails on is logged and left for the next run. */
async function runPass<Item extends { id: RecordId }>(
	name: string,
	items: Item[],
	enrichItem: (item: Item) => Promise<void>
): Promise<void> {
	if (items.length === 0) return;
	const startedAt = performance.now();
	let failed = 0;
	for (const [index, item] of items.entries()) {
		try {
			await enrichItem(item);
		} catch (error) {
			if (!(error instanceof ItemSkipped || error instanceof ModelError)) throw error;
			failed++;
			console.warn(`  ${name} ${String(item.id.id)} skipped: ${error.message}`);
		}
		if ((index + 1) % PROGRESS_INTERVAL === 0 && index + 1 < items.length) {
			console.log(`  ${name}: ${index + 1} of ${items.length}`);
		}
	}
	const seconds = (performance.now() - startedAt) / 1000;
	const failure = failed > 0 ? `, ${failed} skipped` : '';
	console.log(
		`  ${name}: ${items.length - failed} of ${items.length} done in ${seconds.toFixed(1)} s ` +
			`(${((seconds / items.length) * 1000).toFixed(0)} ms each${failure})`
	);
}

/** So a worker that enriches many crawls says once that there is no embedder, not once per crawl. */
let reportedMissingEmbedder = false;

/**
 * Fills in what the models contribute to one crawl: `page_type` and `description` of its screens,
 * `label` of its sections, `embedding` of both, and `category`, `title` and step captions of its
 * flows. Only items without a result are sent, so it is safe to call again on a finished or
 * half-enriched crawl. A flow that already has a category is never renamed; a flow that was born
 * with one still gets its captions. Flows cut from the old structural crawl are not named.
 */
export async function enrichCrawl(
	db: Surreal,
	crawlId: RecordId,
	mediaStore: MediaStore = localMedia(process.env.MEDIA_DIR ?? 'data/media')
): Promise<void> {
	const models = modelConfigFromEnv(process.env);

	async function readImage(key: string): Promise<Uint8Array> {
		const bytes = await mediaStore.get(key);
		if (bytes === undefined) throw new ItemSkipped(`media file is missing: ${key}`);
		return bytes;
	}

	const sectionsOfCrawl = `kind = 'section' AND crawl = $crawl`;
	const [unclassified, unembeddedScreens, sectionsWithoutLabel, unembeddedSections, unnamedFlows] =
		await db
			.query(
				`SELECT id, url, title, media.viewport AS image FROM screen
				 	WHERE crawl = $crawl AND page_type IS NONE ORDER BY seq;
				 SELECT id, url, title, media.viewport AS image FROM screen
				 	WHERE crawl = $crawl AND embedding IS NONE ORDER BY seq;
				 SELECT id, media AS image FROM element
				 	WHERE ${sectionsOfCrawl} AND label IS NONE;
				 SELECT id, media AS image FROM element
				 	WHERE ${sectionsOfCrawl} AND embedding IS NONE;
				 SELECT id, category, steps, steps.screen.url AS urls, steps.screen.media.viewport AS images,
				 	steps.action.label AS labels FROM flow
				 	WHERE crawl = $crawl AND source IN ['goal', 'request']
				 		AND (category IS NONE OR steps[0].caption IS NONE);`,
				{ crawl: crawlId }
			)
			.collect<
				[ScreenToEnrich[], ScreenToEnrich[], SectionToEnrich[], SectionToEnrich[], FlowToName[]]
			>();

	console.log(`crawl ${String(crawlId.id)}`);

	await runPass('classify screens', unclassified, async (screen) => {
		const { pageType, description } = await classifyScreen(models.vlm, {
			image: await readImage(screen.image),
			url: screen.url,
			title: screen.title
		});
		await db
			.query('UPDATE $screen SET page_type = $pageType, description = $description', {
				screen: screen.id,
				pageType,
				description
			})
			.collect();
	});

	await runPass('label sections', sectionsWithoutLabel, async (section) => {
		const label = await labelElement(models.vlm, {
			image: await readImage(section.image),
			kind: 'section'
		});
		await db.query('UPDATE $element SET label = $label', { element: section.id, label }).collect();
	});

	await runPass('name flows', unnamedFlows, async (flow) => {
		// Reading only the steps the model will look at also spares the files of a long flow.
		const shownImages = flow.images.slice(0, MAX_FLOW_STEPS);
		const result = await nameFlow(
			models.vlm,
			await Promise.all(
				shownImages.map(async (key, index) => ({
					image: await readImage(key),
					url: flow.urls[index],
					actionLabel: flow.labels[index]
				}))
			),
			flow.category
		);
		// The model only sees the first steps of a long flow, so later steps get no caption.
		const steps = flow.steps.map((step, index) => ({ ...step, caption: result.captions[index] }));
		// A flow that arrived with a category keeps it and its title, and only gains captions.
		if (flow.category !== undefined) {
			await db.query('UPDATE $flow SET steps = $steps', { flow: flow.id, steps }).collect();
			return;
		}
		await db
			.query('UPDATE $flow SET category = $category, title = $title, steps = $steps', {
				flow: flow.id,
				category: result.category,
				title: result.title,
				steps
			})
			.collect();
	});

	const embedder = models.embedding;
	if (embedder === undefined) {
		// Nothing is retried or failed: the items stay without an embedding until an embedder is set.
		if (!reportedMissingEmbedder)
			console.log('  embeddings skipped: REFS_EMBEDDING_URL is not set');
		reportedMissingEmbedder = true;
		return;
	}

	await runPass('embed screens', unembeddedScreens, async (screen) => {
		const vector = await embed(embedder, { image: await readImage(screen.image) });
		await db
			.query('UPDATE $screen SET embedding = $vector', { screen: screen.id, vector })
			.collect();
	});

	await runPass('embed sections', unembeddedSections, async (section) => {
		const vector = await embed(embedder, { image: await readImage(section.image) });
		await db
			.query('UPDATE $element SET embedding = $vector', { element: section.id, vector })
			.collect();
	});
}

if (import.meta.main) {
	const siteSlug: string | undefined = process.argv[2];
	const db = await connect(configFromEnv(process.env));
	try {
		const crawls = await sourceCrawls(db, siteSlug);
		if (crawls.length === 0) {
			throw new Error(
				siteSlug === undefined
					? 'There are no crawls to enrich.'
					: `Site "${siteSlug}" has no crawls.`
			);
		}
		const startedAt = performance.now();
		for (const crawl of crawls) {
			console.log(`${crawl.site} ${crawl.viewport}`);
			await enrichCrawl(db, new RecordId('crawl', crawl.id));
		}
		console.log(`done in ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
	} catch (error) {
		// One readable line instead of a stack trace; the messages above already say what to do.
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	} finally {
		await db.close();
	}
}
