import {
	cancelCrawls,
	getScreenDetail,
	listElements,
	listScreens,
	recrawl
} from '#lib/server/queries.ts';
import type { ElementKind, SectionLabel, Viewport } from '#lib/types.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, parent }) => {
	// Calling parent() also re-runs this load whenever the layout is invalidated, which is what
	// keeps the grids live while a crawl is running.
	const { site, sources, screenCounts } = await parent();

	const viewportParam = url.searchParams.get('viewport');
	let viewport: Viewport;
	if (viewportParam === 'desktop' || viewportParam === 'mobile') viewport = viewportParam;
	// Without an explicit choice, land on the viewport that actually has screens.
	else viewport = screenCounts.desktop === 0 && screenCounts.mobile > 0 ? 'mobile' : 'desktop';

	const tab = url.searchParams.get('tab') === 'elements' ? 'elements' : 'screens';
	// An unknown kind is harmless: it is a query parameter and just matches no elements.
	const kind = (url.searchParams.get('kind') ?? undefined) as ElementKind | undefined;
	const label = (url.searchParams.get('label') ?? undefined) as SectionLabel | undefined;
	const pageType = url.searchParams.get('type') ?? undefined;
	const screenParam = url.searchParams.get('screen');

	const crawlId = sources[viewport];
	const [screenList, elementList, viewer] = await Promise.all([
		tab === 'screens' && crawlId ? listScreens(crawlId, pageType) : undefined,
		tab === 'elements' && crawlId ? listElements(crawlId, { kind, label }) : undefined,
		screenParam ? getScreenDetail(site.id, screenParam) : undefined
	]);

	return {
		viewport,
		tab,
		kind,
		label,
		pageType,
		screens: screenList?.screens ?? [],
		pageTypeCounts: screenList?.pageTypeCounts ?? {},
		elements: elementList?.elements ?? [],
		labelCounts: elementList?.labelCounts ?? {},
		viewer
	};
};

export const actions: Actions = {
	recrawl: async ({ params }) => {
		await recrawl(params.slug);
	},
	cancel: async ({ params }) => {
		await cancelCrawls(params.slug);
	}
};
