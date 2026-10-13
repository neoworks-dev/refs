import { json } from '@sveltejs/kit';
import { searchAll } from '#lib/server/queries.ts';
import type { RequestHandler } from './$types';

/** JSON endpoint behind the search palette (`/search?q=`). */
export const GET: RequestHandler = async ({ url }) => {
	return json(await searchAll(url.searchParams.get('q') ?? ''));
};
