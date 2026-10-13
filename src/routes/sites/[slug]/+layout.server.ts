import { error } from '@sveltejs/kit';
import { getSiteOverview } from '#lib/server/queries.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ params, depends }) => {
	// The page polls this key while a crawl is active (see +page.svelte).
	depends('app:site');
	const overview = await getSiteOverview(params.slug);
	if (!overview) error(404, 'Site not found');
	return overview;
};
