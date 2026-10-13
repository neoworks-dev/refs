import { deleteCollection, getCollection, updateCollection } from '#lib/server/collections.ts';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url }) => {
	const detail = await getCollection(params.slug);
	if (!detail) error(404, 'Collection not found');
	const show = url.searchParams.get('show');
	return { ...detail, show: show === 'screens' || show === 'elements' ? show : undefined };
};

export const actions: Actions = {
	update: async ({ params, request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (name === '') return fail(400, { message: 'Give the collection a name.' });
		await updateCollection(params.slug, {
			name,
			description: String(form.get('description') ?? '').trim() || undefined
		});
	},
	delete: async ({ params }) => {
		await deleteCollection(params.slug);
		redirect(303, '/collections');
	}
};
