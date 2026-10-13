import { listLibrary } from '#lib/server/queries.ts';
import type { ElementKind, SectionLabel } from '#lib/types.ts';
import type { PageServerLoad } from './$types';

// Elements shown per "Load more". A multiple of 12 fills whole rows at every column count.
const PAGE_SIZE = 48;

export const load: PageServerLoad = async ({ url }) => {
	const viewport = url.searchParams.get('viewport') === 'mobile' ? 'mobile' : 'desktop';
	// An unknown kind is harmless: it is a query parameter and just matches no elements.
	const kind = (url.searchParams.get('kind') ?? undefined) as ElementKind | undefined;
	const label = (url.searchParams.get('label') ?? undefined) as SectionLabel | undefined;
	// Pages are cumulative (`?pages=2` shows two pages' worth), so "Load more" is a plain link
	// that works without JS and keeps the elements already on screen.
	const pages = Math.max(1, Number(url.searchParams.get('pages')) || 1);

	const library = await listLibrary({ viewport, kind, label }, PAGE_SIZE * pages);
	return { viewport, kind, label, pages, ...library };
};
