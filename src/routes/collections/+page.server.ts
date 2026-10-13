import { isSavedTable } from '#lib/saved.ts';
import { createCollection, listCollections, setSaved } from '#lib/server/collections.ts';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({ items: await listCollections() });

// The save buttons on every page post to these two actions, so they live next to the list.
export const actions: Actions = {
	/** Creates a collection, and saves the thing the picker was opened on into it when given. */
	create: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (name === '') return fail(400, { message: 'Give the collection a name.' });
		const description = String(form.get('description') ?? '').trim() || undefined;

		const collection = await createCollection(name, description);
		const table = form.get('table');
		const id = form.get('id');
		if (isSavedTable(table) && typeof id === 'string') {
			await setSaved(collection.slug, table, id, true);
		}
		return { created: collection.slug };
	},

	/** Saves or removes one thing. The form says which, so repeating it does no harm. */
	toggle: async ({ request }) => {
		const form = await request.formData();
		const slug = form.get('collection');
		const table = form.get('table');
		const id = form.get('id');
		if (typeof slug !== 'string' || !isSavedTable(table) || typeof id !== 'string') {
			error(400, 'Missing collection, table or id');
		}
		if (!(await setSaved(slug, table, id, form.get('saved') === 'true'))) {
			error(404, 'Nothing to save');
		}
	}
};
