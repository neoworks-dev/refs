// Every query behind collections: the pages, the save picker and the form actions. A collection
// holds screens, elements and flows through the `saved` relation, and nothing here assumes there
// are only some kinds: a new one is a new entry of SAVED_TABLES and one more query in `getCollection`.
import { savedKey, type SavedTable } from '../saved.ts';
import type { Collection, Flow, Rect, Screen, Viewport } from '../types.ts';
import { db } from './db.ts';
import { rows as queryRows } from './library.ts';
import type { LibraryElement } from './queries.ts';
import { RecordId } from './surreal.ts';

/** Runs a query with a single statement on the app's connection and returns its rows as plain JSON. */
async function rows<Row>(sql: string, variables: Record<string, unknown> = {}): Promise<Row[]> {
	return queryRows<Row>(await db(), sql, variables);
}

// ---------------------------------------------------------------------------------------------
// The save picker
// ---------------------------------------------------------------------------------------------

export interface PickerCollection {
	id: string;
	name: string;
	slug: string;
	count: number;
}

/**
 * What every save button needs, loaded once by the root layout: the collections, and for each
 * saved thing the collections that hold it. A button then shows its checkmarks without asking the
 * server when the picker opens, and works the same without JavaScript.
 */
export interface PickerData {
	collections: PickerCollection[];
	savedIn: Record<string, string[]>;
}

/** The existing saved things only: a screen deleted after it was saved leaves a dangling link. */
const LIVE_SAVED =
	'SELECT in AS collection, out, record::tb(out) AS item_table FROM saved WHERE record::exists(out)';

export async function getPickerData(): Promise<PickerData> {
	const [collections, saved] = await Promise.all([
		rows<Omit<PickerCollection, 'count'>>(
			'SELECT id, name, slug FROM collection ORDER BY created_at DESC'
		),
		rows<{ collection: string; out: string; item_table: SavedTable }>(LIVE_SAVED)
	]);
	const counts = new Map<string, number>();
	const savedIn: PickerData['savedIn'] = {};
	for (const link of saved) {
		counts.set(link.collection, (counts.get(link.collection) ?? 0) + 1);
		const key = savedKey(link.item_table, link.out);
		if (savedIn[key] === undefined) savedIn[key] = [];
		savedIn[key].push(link.collection);
	}
	return {
		collections: collections.map((collection) => ({
			...collection,
			count: counts.get(collection.id) ?? 0
		})),
		savedIn
	};
}

// ---------------------------------------------------------------------------------------------
// The collections page
// ---------------------------------------------------------------------------------------------

/** The newest saved thing of a collection, which stands in for the whole collection on its card. */
export type CollectionCover =
	| { table: 'screen'; thumb: string; width: number; height: number; viewport: Viewport }
	| { table: 'element'; media: string; rect: Rect };

export interface CollectionListItem extends Collection {
	count: number;
	cover?: CollectionCover;
}

/** All collections, newest first, each with its item count and a cover. */
export async function listCollections(): Promise<CollectionListItem[]> {
	const [collections, saved] = await Promise.all([
		rows<Collection>('SELECT * FROM collection ORDER BY created_at DESC'),
		rows<{ collection: string; out: string; item_table: SavedTable }>(
			`${LIVE_SAVED} ORDER BY saved_at DESC`
		)
	]);

	const counts = new Map<string, number>();
	const newest = new Map<string, { out: string; item_table: SavedTable }>();
	for (const link of saved) {
		counts.set(link.collection, (counts.get(link.collection) ?? 0) + 1);
		// The rows are newest first, so the first one seen per collection is its cover.
		if (!newest.has(link.collection)) newest.set(link.collection, link);
	}

	const coverIds = (table: SavedTable) =>
		[...newest.values()]
			.filter((link) => link.item_table === table)
			.map((link) => new RecordId(table, link.out));
	// A flow's cover is the first screen of the flow.
	const flowFirstScreens = await rows<{ id: string; screen?: string }>(
		'SELECT id, steps[0].screen AS screen FROM flow WHERE id IN $ids',
		{ ids: coverIds('flow') }
	);
	const firstScreenByFlow = new Map(flowFirstScreens.map((flow) => [flow.id, flow.screen]));
	const screenIds = [
		...coverIds('screen'),
		...flowFirstScreens.flatMap((flow) =>
			flow.screen === undefined ? [] : [new RecordId('screen', flow.screen)]
		)
	];
	const [screens, elements] = await Promise.all([
		rows<{ id: string; thumb: string; width: number; height: number; viewport: Viewport }>(
			'SELECT id, media.thumb AS thumb, width, height, viewport FROM screen WHERE id IN $ids',
			{ ids: screenIds }
		),
		rows<{ id: string; media: string; rect: Rect }>(
			'SELECT id, media, rect FROM element WHERE id IN $ids',
			{ ids: coverIds('element') }
		)
	]);
	const screenById = new Map(screens.map((screen) => [screen.id, screen]));
	const elementById = new Map(elements.map((element) => [element.id, element]));

	return collections.map((collection) => {
		const link = newest.get(collection.id);
		let cover: CollectionCover | undefined;
		if (link?.item_table === 'screen' || link?.item_table === 'flow') {
			const screenId = link.item_table === 'flow' ? firstScreenByFlow.get(link.out) : link.out;
			const screen = screenId === undefined ? undefined : screenById.get(screenId);
			if (screen) cover = { table: 'screen', ...screen };
		} else if (link?.item_table === 'element') {
			const element = elementById.get(link.out);
			if (element) cover = { table: 'element', media: element.media, rect: element.rect };
		}
		return { ...collection, count: counts.get(collection.id) ?? 0, cover };
	});
}

// ---------------------------------------------------------------------------------------------
// One collection
// ---------------------------------------------------------------------------------------------

export interface SavedScreen extends Screen {
	site_name: string;
	site_icon?: string;
}

export interface SavedFlow extends Flow {
	site_name: string;
	site_icon?: string;
	/** The first few screens of the flow, which the collection page shows as its preview. */
	previews: { id: string; thumb: string; width: number; height: number }[];
}

export interface CollectionDetail {
	collection: Collection;
	/** The lists are newest saved first. */
	screens: SavedScreen[];
	elements: LibraryElement[];
	flows: SavedFlow[];
}

/** How many screens of a saved flow its card previews. */
const FLOW_PREVIEW_STEPS = 3;

export async function getCollection(slug: string): Promise<CollectionDetail | undefined> {
	const [collection] = await rows<Collection>('SELECT * FROM collection WHERE slug = $slug', {
		slug
	});
	if (!collection) return undefined;

	const saved = await rows<{ out: string; item_table: SavedTable }>(
		`SELECT out, record::tb(out) AS item_table FROM saved
		 WHERE in = $collection AND record::exists(out) ORDER BY saved_at DESC`,
		{ collection: new RecordId('collection', collection.id) }
	);
	const idsOf = (table: SavedTable) =>
		saved.filter((link) => link.item_table === table).map((link) => new RecordId(table, link.out));

	const [screens, elements, flows] = await Promise.all([
		rows<SavedScreen>(
			`SELECT *, site.name AS site_name, site.icon AS site_icon OMIT embedding
			 FROM screen WHERE id IN $ids`,
			{ ids: idsOf('screen') }
		),
		rows<LibraryElement>(
			`SELECT *, screen.seq AS screen_seq, screen.path AS screen_path,
				site.name AS site_name, site.icon AS site_icon OMIT embedding
			 FROM element WHERE id IN $ids`,
			{ ids: idsOf('element') }
		),
		rows<Flow & { site_name: string; site_icon?: string }>(
			'SELECT *, site.name AS site_name, site.icon AS site_icon FROM flow WHERE id IN $ids',
			{ ids: idsOf('flow') }
		)
	]);

	const previewScreens = await rows<SavedFlow['previews'][number]>(
		'SELECT id, media.thumb AS thumb, width, height FROM screen WHERE id IN $ids',
		{
			ids: flows.flatMap((flow) =>
				flow.steps.slice(0, FLOW_PREVIEW_STEPS).map((step) => new RecordId('screen', step.screen))
			)
		}
	);
	const previewById = new Map(previewScreens.map((screen) => [screen.id, screen]));

	// `IN` returns rows in table order, so put them back in the order they were saved.
	const position = new Map(saved.map((link, index) => [link.out, index]));
	const bySavedOrder = (first: { id: string }, second: { id: string }) =>
		(position.get(first.id) ?? 0) - (position.get(second.id) ?? 0);
	return {
		collection,
		screens: screens.sort(bySavedOrder),
		elements: elements.sort(bySavedOrder),
		flows: flows
			.map((flow) => ({
				...flow,
				previews: flow.steps
					.slice(0, FLOW_PREVIEW_STEPS)
					.flatMap((step) => previewById.get(step.screen) ?? [])
			}))
			.sort(bySavedOrder)
	};
}

// ---------------------------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------------------------

/** The slug a name turns into: lowercase words joined by dashes, without accents or symbols. */
function slugify(name: string): string {
	const slug = name
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	// A name made only of symbols or another script has nothing left to use.
	return slug === '' ? 'collection' : slug;
}

/**
 * Creates a collection and returns it. The slug is its record id too, so two collections can
 * never share one: a name that is taken gets the next free number, as in `dark-mode-2`.
 */
export async function createCollection(name: string, description?: string): Promise<Collection> {
	const base = slugify(name);
	const taken = new Set(
		await rows<string>('SELECT VALUE slug FROM collection WHERE string::starts_with(slug, $base)', {
			base
		})
	);
	let slug = base;
	for (let suffix = 2; taken.has(slug); suffix++) slug = `${base}-${suffix}`;

	// Creating an existing record id fails, which settles a race between two creates of one name.
	const [collection] = await rows<Collection>(
		'CREATE $record CONTENT { name: $name, slug: $slug, description: $description }',
		{ record: new RecordId('collection', slug), name, slug, description }
	);
	return collection;
}

/** Renames and describes a collection. Its slug stays, so links to it keep working. */
export async function updateCollection(
	slug: string,
	changes: { name: string; description?: string }
): Promise<void> {
	await rows('UPDATE $record SET name = $name, description = $description', {
		record: new RecordId('collection', slug),
		...changes
	});
}

/** Deletes the collection and what it holds. The saved screens and elements stay in the library. */
export async function deleteCollection(slug: string): Promise<void> {
	const record = new RecordId('collection', slug);
	await rows('DELETE saved WHERE in = $record', { record });
	await rows('DELETE $record', { record });
}

/**
 * Puts a thing into a collection or takes it out. Saving twice and removing twice are both fine,
 * so a double click or a stale picker cannot fail. Returns false when the thing does not exist.
 */
export async function setSaved(
	slug: string,
	table: SavedTable,
	id: string,
	saved: boolean
): Promise<boolean> {
	const collection = new RecordId('collection', slug);
	const item = new RecordId(table, id);
	if (!saved) {
		await rows('DELETE saved WHERE in = $collection AND out = $item', { collection, item });
		return true;
	}
	const existing = await rows('SELECT id FROM $item', { item });
	if (existing.length === 0) return false;
	// The unique index on (in, out) makes a repeated insert return the existing link.
	await rows(
		'INSERT RELATION INTO saved { in: $collection, out: $item } ON DUPLICATE KEY UPDATE in = $collection',
		{
			collection,
			item
		}
	);
	return true;
}
