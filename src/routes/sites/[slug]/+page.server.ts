import {
	cancelCrawls,
	getFlowSteps,
	getScreenDetail,
	listElements,
	listFlows,
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

	const tabParam = url.searchParams.get('tab');
	const tab = tabParam === 'elements' || tabParam === 'flows' ? tabParam : 'screens';
	// An unknown kind is harmless: it is a query parameter and just matches no elements.
	const kind = (url.searchParams.get('kind') ?? undefined) as ElementKind | undefined;
	const label = (url.searchParams.get('label') ?? undefined) as SectionLabel | undefined;
	const pageType = url.searchParams.get('type') ?? undefined;
	const screenParam = url.searchParams.get('screen');

	const crawlId = sources[viewport];
	const [screenList, elementList, flowList, viewer] = await Promise.all([
		tab === 'screens' && crawlId ? listScreens(crawlId, pageType) : undefined,
		tab === 'elements' && crawlId ? listElements(crawlId, { kind, label }) : undefined,
		tab === 'flows' && crawlId ? listFlows(crawlId) : undefined,
		screenParam ? getScreenDetail(site.id, screenParam) : undefined
	]);

	// An unknown or missing `?flow=` shows the first flow of the tree.
	const flows = flowList ?? [];
	const flow = flows.find((candidate) => candidate.id === url.searchParams.get('flow')) ?? flows[0];
	const flowSteps = flow ? await getFlowSteps(flow) : [];

	// A screen opened from a flow is browsed along that flow: previous and next are its
	// neighbouring steps instead of the neighbouring captures. A screen that isn't one of the
	// steps, such as one reached through "Reached by", keeps the capture order.
	let flowPosition:
		{ prevId?: string; nextId?: string; position: number; total: number } | undefined;
	const stepIndex = flowSteps.findIndex((step) => step.screen.id === viewer?.screen.id);
	if (viewer && stepIndex !== -1) {
		flowPosition = {
			prevId: flowSteps[stepIndex - 1]?.screen.id,
			nextId: flowSteps[stepIndex + 1]?.screen.id,
			position: stepIndex + 1,
			total: flowSteps.length
		};
	}

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
		flows,
		flow,
		flowSteps,
		viewer: viewer && { ...viewer, ...flowPosition },
		viewerFlowTitle: flowPosition && flow?.title
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
