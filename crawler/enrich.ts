// Runs the captured screens and section crops of a crawl through the model service (ml/): page
// type and description per screen, a label per section, an embedding for both, and a category,
// title and step captions per flow. Resumable, because every pass only picks up what has no
// result yet, so it backfills crawls from before the models existed and carries on where an
// interrupted run stopped.
//
// `bun crawler/enrich.ts [site-slug]` enriches the current crawls of one site, or of every site.
import type { Surreal } from 'surrealdb';
import { localMedia, type MediaStore } from '#lib/server/media.ts';
import { configFromEnv, connect, RecordId } from '#lib/server/surreal.ts';
import { sourceCrawls } from '#lib/server/library.ts';

const MODEL_SERVICE_URL = process.env.REFS_ML_URL ?? 'http://127.0.0.1:8022';

/**
 * Vector size stored in the database. It must match the HNSW index in db/schema.surql. 1024 found
 * the same neighbours as the model's full 2048 dimensions, while 512 did not (issue #7).
 */
const EMBEDDING_DIMENSIONS = 1024;

/** How many items pass between two progress lines of a long run. */
const PROGRESS_INTERVAL = 25;

/**
 * One item can't be enriched right now: the model service refused its image, or the file isn't
 * there yet because a running crawl records a screen before its media is written. The run goes on
 * and the next run tries the item again.
 */
class ItemSkipped extends Error {}

interface ScreenToEnrich {
	id: RecordId;
	url: string;
	title: string;
	image: string;
}

interface FlowToName {
	id: RecordId;
	/** The steps as stored, so naming only adds captions and leaves screens and actions alone. */
	steps: { screen: RecordId; action?: RecordId; caption?: string }[];
	urls: string[];
	images: string[];
	/** Label of the click that led to each step; the first step has none. */
	labels: (string | undefined)[];
}

interface SectionToEnrich {
	id: RecordId;
	image: string;
}

/** Posts a form to the model service. Requests go one at a time, as the GPU serves one at a time. */
async function callModel<Result>(endpoint: string, form: FormData): Promise<Result> {
	let response: Response;
	try {
		response = await fetch(`${MODEL_SERVICE_URL}${endpoint}`, { method: 'POST', body: form });
	} catch (error) {
		// fetch only rejects when no response arrived at all: the service is down or not listening.
		throw new Error(
			`The model service at ${MODEL_SERVICE_URL} is not reachable (${(error as Error).message}). ` +
				'Start it with "cd ml && uv run serve", or set REFS_ML_URL.',
			{ cause: error }
		);
	}
	if (!response.ok) {
		throw new ItemSkipped(`${endpoint} answered ${response.status}: ${await response.text()}`);
	}
	return (await response.json()) as Result;
}

/** Runs one pass over `items`. An image the model refuses is logged and left for the next run. */
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
			if (!(error instanceof ItemSkipped)) throw error;
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

/**
 * Fills in what the models contribute to one crawl: `page_type` and `description` of its screens,
 * `label` of its sections, `embedding` of both, and `category`, `title` and step captions of its
 * flows. Only items without a result are sent, so it is safe to call again on a finished or
 * half-enriched crawl. A flow that already has a category is never renamed.
 */
export async function enrichCrawl(
	db: Surreal,
	crawlId: RecordId,
	mediaStore: MediaStore = localMedia(process.env.MEDIA_DIR ?? 'data/media')
): Promise<void> {
	async function imageForm(key: string): Promise<FormData> {
		const bytes = await mediaStore.get(key);
		if (bytes === undefined) throw new ItemSkipped(`media file is missing: ${key}`);
		const form = new FormData();
		form.set(
			'image',
			new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/webp' }),
			'image.webp'
		);
		return form;
	}

	async function embedImage(key: string): Promise<number[]> {
		const form = await imageForm(key);
		form.set('dimensions', String(EMBEDDING_DIMENSIONS));
		const result = await callModel<{ vector: number[] }>('/embed', form);
		return result.vector;
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
				 SELECT id, steps, steps.screen.url AS urls, steps.screen.media.viewport AS images,
				 	steps.action.label AS labels FROM flow
				 	WHERE crawl = $crawl AND category IS NONE;`,
				{ crawl: crawlId }
			)
			.collect<
				[ScreenToEnrich[], ScreenToEnrich[], SectionToEnrich[], SectionToEnrich[], FlowToName[]]
			>();

	console.log(`crawl ${String(crawlId.id)}`);

	await runPass('classify screens', unclassified, async (screen) => {
		const form = await imageForm(screen.image);
		form.set('url', screen.url);
		form.set('title', screen.title);
		const result = await callModel<{ page_type: string; description: string }>(
			'/classify-screen',
			form
		);
		await db
			.query('UPDATE $screen SET page_type = $pageType, description = $description', {
				screen: screen.id,
				pageType: result.page_type,
				description: result.description
			})
			.collect();
	});

	await runPass('label sections', sectionsWithoutLabel, async (section) => {
		const form = await imageForm(section.image);
		form.set('kind', 'section');
		const result = await callModel<{ label: string }>('/label-element', form);
		await db
			.query('UPDATE $element SET label = $label', { element: section.id, label: result.label })
			.collect();
	});

	await runPass('name flows', unnamedFlows, async (flow) => {
		const form = new FormData();
		for (const key of flow.images) {
			const bytes = await mediaStore.get(key);
			if (bytes === undefined) throw new ItemSkipped(`media file is missing: ${key}`);
			form.append(
				'images',
				new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/webp' }),
				'image.webp'
			);
		}
		form.set(
			'steps',
			JSON.stringify(
				flow.urls.map((url, index) => ({ url, action_label: flow.labels[index] ?? '' }))
			)
		);
		const result = await callModel<{ category: string; title: string; captions: string[] }>(
			'/name-flow',
			form
		);
		// The model only sees the first steps of a long flow, so later steps get no caption.
		const steps = flow.steps.map((step, index) => ({ ...step, caption: result.captions[index] }));
		await db
			.query('UPDATE $flow SET category = $category, title = $title, steps = $steps', {
				flow: flow.id,
				category: result.category,
				title: result.title,
				steps
			})
			.collect();
	});

	await runPass('embed screens', unembeddedScreens, async (screen) => {
		const vector = await embedImage(screen.image);
		await db
			.query('UPDATE $screen SET embedding = $vector', { screen: screen.id, vector })
			.collect();
	});

	await runPass('embed sections', unembeddedSections, async (section) => {
		const vector = await embedImage(section.image);
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
