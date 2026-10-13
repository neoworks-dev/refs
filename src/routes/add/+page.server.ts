import { fail, redirect } from '@sveltejs/kit';
import { normaliseUrl } from '#lib/server/library.ts';
import { addSite } from '#lib/server/queries.ts';
import type { Viewport } from '#lib/types.ts';
import type { Actions } from './$types';

const MAX_SCREENS_LIMIT = 500;

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const rawUrl = String(form.get('url') ?? '');
		const rawMaxScreens = String(form.get('max_screens') ?? '30').trim();
		// A Set drops duplicates; anything that is not a known viewport is ignored.
		const viewports = [...new Set(form.getAll('viewport').map(String))].filter(
			(value): value is Viewport => value === 'desktop' || value === 'mobile'
		);

		const errors: { url?: string; viewports?: string; max_screens?: string } = {};
		const url = normaliseUrl(rawUrl);
		if (!rawUrl.trim()) errors.url = 'Enter the address of a website.';
		else if (!url) errors.url = "That doesn't look like a valid website address.";

		if (viewports.length === 0) errors.viewports = 'Pick at least one viewport.';

		const maxScreens = Number(rawMaxScreens);
		if (!Number.isInteger(maxScreens) || maxScreens < 1 || maxScreens > MAX_SCREENS_LIMIT) {
			errors.max_screens = `Use a whole number from 1 to ${MAX_SCREENS_LIMIT}.`;
		}

		if (!url || Object.keys(errors).length > 0) {
			return fail(400, { errors, values: { url: rawUrl } });
		}

		const { slug } = await addSite({ url, viewports, maxScreens });
		redirect(303, `/sites/${slug}`);
	}
};
