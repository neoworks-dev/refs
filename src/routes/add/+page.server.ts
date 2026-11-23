import { fail, redirect } from '@sveltejs/kit';
import { normaliseUrl } from '#lib/server/library.ts';
import { addSite } from '#lib/server/queries.ts';
import type { Viewport } from '#lib/types.ts';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const rawUrl = String(form.get('url') ?? '');
		// A Set drops duplicates; anything that is not a known viewport is ignored.
		const viewports = [...new Set(form.getAll('viewport').map(String))].filter(
			(value): value is Viewport => value === 'desktop' || value === 'mobile'
		);

		const errors: { url?: string; viewports?: string } = {};
		const url = normaliseUrl(rawUrl);
		if (!rawUrl.trim()) errors.url = 'Enter the address of a website.';
		else if (!url) errors.url = "That doesn't look like a valid website address.";

		if (viewports.length === 0) errors.viewports = 'Pick at least one viewport.';

		if (!url || Object.keys(errors).length > 0) {
			return fail(400, { errors, values: { url: rawUrl } });
		}

		const { slug } = await addSite({ url, viewports });
		redirect(303, `/sites/${slug}`);
	}
};
