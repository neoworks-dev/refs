import { json } from '@sveltejs/kit';
import { searchAll, searchByMeaning } from '#lib/server/queries.ts';
import type { RequestHandler } from './$types';

/**
 * JSON endpoint behind the search palette. `/search?q=` answers with the name matches at once;
 * `/search?q=&by=meaning` embeds the query first, which takes longer, so the palette asks for it
 * separately and shows the name matches in the meantime.
 */
export const GET: RequestHandler = async ({ url }) => {
	const query = url.searchParams.get('q') ?? '';
	if (url.searchParams.get('by') === 'meaning') return json(await searchByMeaning(query));
	return json(await searchAll(query));
};
