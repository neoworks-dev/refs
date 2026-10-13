import { listSites } from '#lib/server/queries.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const query = url.searchParams.get('q') ?? '';
	return {
		query,
		viewport:
			url.searchParams.get('viewport') === 'mobile' ? ('mobile' as const) : ('desktop' as const),
		sites: await listSites(query)
	};
};
