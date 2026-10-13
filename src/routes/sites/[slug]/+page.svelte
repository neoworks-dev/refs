<script lang="ts">
	import { afterNavigate, goto, invalidate } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Box } from '@lucide/svelte';
	import CrawlStatus from '#lib/components/CrawlStatus.svelte';
	import FilterChips from '#lib/components/FilterChips.svelte';
	import ElementTile from '#lib/components/ElementTile.svelte';
	import ScreenCard from '#lib/components/ScreenCard.svelte';
	import ScreenViewer from '#lib/components/ScreenViewer.svelte';
	import SaveButton from '#lib/components/SaveButton.svelte';
	import SegmentedToggle from '#lib/components/SegmentedToggle.svelte';
	import SiteIcon from '#lib/components/SiteIcon.svelte';
	import { humanise, kindLabels, kinds } from '#lib/labels.ts';
	import {
		PAGE_TYPES,
		SECTION_LABELS,
		type ElementKind,
		type Flow,
		type Viewport
	} from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const viewports: Viewport[] = ['desktop', 'mobile'];

	const activeCrawls = $derived(
		data.crawls.filter((crawl) => crawl.status === 'queued' || crawl.status === 'running')
	);
	const totalScreens = $derived(data.screenCounts.desktop + data.screenCounts.mobile);
	const totalFlows = $derived(data.flowCounts.desktop + data.flowCounts.mobile);
	const totalElements = $derived(
		viewports
			.flatMap((viewport) => Object.values(data.kindCounts[viewport]))
			.reduce((total, count) => total + count, 0)
	);
	// A filter that matches nothing is not the same as a site that has nothing yet.
	const filtered = $derived(
		data.tab === 'screens' ? data.pageType !== undefined : data.kind !== undefined
	);
	// The tree groups the flows by category. They arrive sorted by category, so a group is a run.
	const flowGroups = $derived.by(() => {
		const groups: { category?: string; flows: Flow[] }[] = [];
		for (const flow of data.flows) {
			const lastGroup = groups.at(-1);
			if (lastGroup && lastGroup.category === flow.category) lastGroup.flows.push(flow);
			else groups.push({ category: flow.category, flows: [flow] });
		}
		return groups;
	});
	// --- flow video ------------------------------------------------------------------------
	// The step the video is at is the last one reached by the current time. The flow is part of the
	// state so that switching flows does not carry the old position over.
	let videoElement = $state<HTMLVideoElement>();
	let stepList = $state<HTMLOListElement>();
	let playback = $state({ flowId: '', time: 0 });
	/** Seeking lands this far past a step's second, so the frame is of that step and not the one before. */
	const SEEK_OFFSET = 0.05;

	function activeStepOf(flow: Flow) {
		if (playback.flowId !== flow.id || flow.video === undefined) return 0;
		const reached = flow.video.steps.filter((second) => second <= playback.time + SEEK_OFFSET);
		return Math.max(reached.length - 1, 0);
	}

	function seekToStep(flow: Flow, index: number) {
		const second = flow.video?.steps[index];
		if (videoElement === undefined || second === undefined) return false;
		videoElement.currentTime = second + SEEK_OFFSET;
		void videoElement.play();
		videoElement.scrollIntoView({ block: 'nearest' });
		return true;
	}

	// While the video plays, the step row follows it. Only the row is scrolled, never the page.
	$effect(() => {
		const active = data.flow ? activeStepOf(data.flow) : 0;
		const card = stepList?.children[active] as HTMLElement | undefined;
		if (card === undefined || stepList === undefined || playback.time === 0) return;
		stepList.scrollTo({ left: card.offsetLeft - stepList.offsetLeft, behavior: 'smooth' });
	});

	const lastCrawled = $derived(
		data.crawls.find((crawl) => crawl.status === 'done' && crawl.finished_at)?.finished_at
	);

	// Poll while a crawl is queued or running so the status strip and the grids fill in live.
	$effect(() => {
		if (activeCrawls.length === 0) return;
		const timer = setInterval(() => invalidate('app:site'), 2500);
		return () => clearInterval(timer);
	});

	/** The current URL with the given params set, or removed when the value is undefined. */
	function link(changes: Record<string, string | undefined>) {
		const params = new URLSearchParams(page.url.searchParams.toString());
		for (const [name, value] of Object.entries(changes)) {
			if (value === undefined) params.delete(name);
			else params.set(name, value);
		}
		const query = params.toString();
		return query ? `${page.url.pathname}?${query}` : page.url.pathname;
	}

	// --- viewer ------------------------------------------------------------------------------
	// The viewer is part of the URL (`?screen=`): opening pushes a history entry, so Back closes
	// it; moving between screens replaces the entry.
	const closeHref = $derived(link({ screen: undefined, el: undefined }));
	let openedFromList = false;

	afterNavigate((navigation) => {
		const opened = navigation.to?.url.searchParams.has('screen') ?? false;
		const wasOpen = navigation.from?.url.searchParams.has('screen') ?? false;
		// Only a viewer opened by an in-app click has a list entry to go back to; a direct visit
		// or reload does not.
		if (!opened) openedFromList = false;
		else if (!wasOpen) openedFromList = navigation.type === 'link' || navigation.type === 'goto';
	});

	function closeViewer() {
		if (openedFromList) history.back();
		else goto(closeHref, { replace: true, reset: false });
	}
</script>

<svelte:head><title>{data.site.name} · Refs</title></svelte:head>

<section class="pt-4">
	<SiteIcon
		name={data.site.name}
		icon={data.site.icon}
		class="size-[72px] rounded-[18px] sm:size-[92px] sm:rounded-[22px]"
	/>
	<h1
		class="mt-5 text-[40px] leading-[1.02] font-semibold tracking-[-0.05em] break-words sm:text-[56px]"
	>
		{data.site.name}
	</h1>
	{#if data.site.description}
		<p
			class="mt-3 line-clamp-2 max-w-3xl text-[17px] leading-snug tracking-[-0.01em] text-neutral-500 sm:text-[20px] dark:text-neutral-400"
		>
			{data.site.description}
		</p>
	{/if}

	<dl class="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 text-[17px] sm:flex sm:flex-wrap sm:gap-x-10">
		<div>
			<dt class="text-[15px] text-neutral-500 dark:text-neutral-400">Viewports</dt>
			<dd class="font-medium">
				<span class="capitalize"
					>{viewports.filter((viewport) => data.sources[viewport]).join(', ')}</span
				>
				{#if !data.sources.desktop && !data.sources.mobile}None yet{/if}
			</dd>
		</div>
		<div>
			<dt class="text-[15px] text-neutral-500 dark:text-neutral-400">Screens</dt>
			<dd class="font-medium">{totalScreens}</dd>
		</div>
		<div>
			<dt class="text-[15px] text-neutral-500 dark:text-neutral-400">Elements</dt>
			<dd class="font-medium">{totalElements}</dd>
		</div>
		<div>
			<dt class="text-[15px] text-neutral-500 dark:text-neutral-400">Flows</dt>
			<dd class="font-medium">{totalFlows}</dd>
		</div>
		<div>
			<dt class="text-[15px] text-neutral-500 dark:text-neutral-400">Last crawled</dt>
			<dd class="font-medium">
				{lastCrawled
					? new Date(lastCrawled).toLocaleDateString('en', { dateStyle: 'medium', timeZone: 'UTC' })
					: 'Never'}
			</dd>
		</div>
		<div>
			<dt class="text-[15px] text-neutral-500 dark:text-neutral-400">Site</dt>
			<dd class="font-medium">
				<a
					href={data.site.url}
					target="_blank"
					rel="noopener noreferrer"
					class="underline-offset-4 hover:underline"
				>
					{data.site.host}
				</a>
			</dd>
		</div>
	</dl>

	<div class="mt-6 flex gap-3">
		<form method="POST" action={activeCrawls.length > 0 ? '?/cancel' : '?/recrawl'} use:enhance>
			<button
				type="submit"
				class="inline-flex h-11 items-center justify-center rounded-full bg-black px-5 text-[15px] font-medium whitespace-nowrap text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:bg-white dark:text-black dark:hover:bg-neutral-200 dark:focus-visible:outline-white"
			>
				{activeCrawls.length > 0 ? 'Cancel crawl' : 'Recrawl'}
			</button>
		</form>
		<a
			href={data.site.url}
			target="_blank"
			rel="noopener noreferrer"
			class="inline-flex h-11 items-center justify-center rounded-full border border-neutral-200 bg-white px-5 text-[15px] font-medium whitespace-nowrap transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:border-white/15 dark:bg-transparent dark:hover:bg-white/10 dark:focus-visible:outline-white"
		>
			Visit site
		</a>
	</div>

	<CrawlStatus crawls={data.crawls} />
</section>

<!-- Below 640px the viewport switch and the tabs stack, because they do not fit side by side. -->
<div
	class="mt-10 flex flex-col gap-4 sm:h-14 sm:flex-row sm:items-center sm:gap-5 sm:border-b sm:border-neutral-200/70 dark:sm:border-white/10"
>
	<SegmentedToggle
		label="Viewport"
		active={data.viewport}
		options={[
			// Switching viewport drops the screen, the kind filter and the flow: all belong to the old one.
			{
				value: 'desktop',
				label: 'Desktop',
				href: link({ viewport: 'desktop', screen: undefined, el: undefined, flow: undefined })
			},
			{
				value: 'mobile',
				label: 'Mobile',
				href: link({ viewport: 'mobile', screen: undefined, el: undefined, flow: undefined })
			}
		]}
	/>
	<span class="hidden h-6 w-px bg-neutral-200 sm:block dark:bg-white/15"></span>
	<nav
		class="flex h-12 items-center gap-7 border-b border-neutral-200/70 sm:h-full sm:border-b-0 dark:border-white/10"
		aria-label="Content"
		data-sveltekit-reset="false"
	>
		<!-- The active tab's underline sits on the row's bottom border. -->
		{#each [{ value: 'screens', label: 'Screens', href: link( { tab: undefined, kind: undefined, label: undefined, flow: undefined } ) }, { value: 'elements', label: 'Elements', href: link( { tab: 'elements', type: undefined, flow: undefined } ) }, { value: 'flows', label: 'Flows', href: link( { tab: 'flows', type: undefined, kind: undefined, label: undefined, flow: undefined } ) }] as tab (tab.value)}
			<a
				href={tab.href}
				aria-current={data.tab === tab.value ? 'page' : undefined}
				class={[
					'relative flex h-full items-center text-[17px] font-medium tracking-tight transition-colors',
					data.tab === tab.value &&
						'text-black after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-black dark:text-white dark:after:bg-white',
					data.tab !== tab.value &&
						'text-neutral-400 hover:text-black dark:text-neutral-500 dark:hover:text-white'
				]}
			>
				{tab.label}
			</a>
		{/each}
	</nav>
</div>

<div class="mt-8">
	{#if data.tab === 'screens'}
		{#if Object.keys(data.pageTypeCounts).length > 0}
			<div class="mb-8">
				<FilterChips
					ariaLabel="Page type"
					values={PAGE_TYPES}
					counts={data.pageTypeCounts}
					label={humanise}
					active={data.pageType}
					href={(pageType) => link({ type: pageType, screen: undefined, el: undefined })}
				/>
			</div>
		{/if}
		{#if data.screens.length > 0}
			<ul
				class={[
					'grid gap-x-5 gap-y-9',
					data.viewport === 'desktop' && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
					data.viewport === 'mobile' && 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
				]}
				data-sveltekit-reset="false"
			>
				{#each data.screens as screen (screen.id)}
					<li><ScreenCard {screen} href={link({ screen: screen.id, el: undefined })} /></li>
				{/each}
			</ul>
		{:else}
			{@render empty('screens')}
		{/if}
	{:else if data.tab === 'flows'}
		{#if data.flow}
			{@render flowsTab(data.flow)}
		{:else}
			{@render empty('flows')}
		{/if}
	{:else}
		<div class="mb-8 flex flex-col gap-3">
			<FilterChips
				ariaLabel="Element kind"
				values={kinds}
				counts={data.kindCounts[data.viewport]}
				label={(kind) => kindLabels[kind as ElementKind]}
				active={data.kind}
				href={(kind) => link({ kind, label: undefined, screen: undefined, el: undefined })}
			/>
			{#if data.kind === 'section' && (Object.keys(data.labelCounts).length > 0 || data.label)}
				<!-- Sections are labelled by the model (hero, pricing, …), a second filter within the kind. -->
				<FilterChips
					compact
					ariaLabel="Section label"
					values={SECTION_LABELS}
					counts={data.labelCounts}
					label={humanise}
					active={data.label}
					href={(label) => link({ label, screen: undefined, el: undefined })}
				/>
			{/if}
		</div>

		{#if data.elements.length > 0}
			<ul
				class="grid grid-flow-dense grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
				data-sveltekit-reset="false"
			>
				{#each data.elements as element (element.id)}
					<ElementTile {element} href={link({ screen: element.screen, el: element.id })} />
				{/each}
			</ul>
		{:else}
			{@render empty('elements')}
		{/if}
	{/if}
</div>

{#if data.viewer}
	<ScreenViewer
		detail={data.viewer}
		site={data.site}
		initialElementId={page.url.searchParams.get('el') ?? undefined}
		flowTitle={data.viewerFlowTitle}
		screenHref={(screenId) => link({ screen: screenId, el: undefined })}
		onclose={closeViewer}
		onnavigate={(screenId) =>
			goto(link({ screen: screenId, el: undefined }), { replace: true, reset: false })}
	/>
{/if}

{#snippet flowsTab(flow: Flow)}
	<!-- From 1024px the tree is a sticky sidebar beside the steps, like Mobbin's. Below that a
	native select replaces it: a tree of ten flows would push the steps off the screen. -->
	<div class="lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-10">
		<nav
			class="hidden lg:sticky lg:top-24 lg:block lg:max-h-[calc(100dvh-8rem)] lg:self-start lg:overflow-y-auto"
			aria-label="Flow tree"
			data-sveltekit-reset="false"
		>
			<h2 class="px-3 pb-3 text-[15px] text-neutral-400 dark:text-neutral-500">Flow tree</h2>
			{#each flowGroups as group (group.category ?? '')}
				<section class="mb-3">
					<h3 class="flex items-baseline justify-between gap-3 px-3 py-2 text-[16px] font-medium">
						{group.category ? humanise(group.category) : 'Uncategorised'}
						<span class="text-[15px] font-normal text-neutral-400 dark:text-neutral-500">
							{group.flows.length}
						</span>
					</h3>
					<ul class="ml-4 border-l border-neutral-200 pl-2 dark:border-white/10">
						{#each group.flows as candidate (candidate.id)}
							<li>
								<a
									href={link({ flow: candidate.id, screen: undefined, el: undefined })}
									aria-current={candidate.id === flow.id ? 'true' : undefined}
									class={[
										'flex items-baseline justify-between gap-3 rounded-xl px-3 py-2 text-[15px] leading-snug transition-colors',
										candidate.id === flow.id &&
											'bg-neutral-100 font-medium text-black dark:bg-white/10 dark:text-white',
										candidate.id !== flow.id &&
											'text-neutral-600 hover:bg-neutral-50 hover:text-black dark:text-neutral-300 dark:hover:bg-white/5 dark:hover:text-white'
									]}
								>
									<span class="min-w-0">{candidate.title || 'Untitled flow'}</span>
									<span class="shrink-0 text-neutral-400 dark:text-neutral-500">
										{candidate.steps.length}
									</span>
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</nav>

		<div class="min-w-0">
			<select
				aria-label="Flow"
				value={flow.id}
				onchange={(event) =>
					goto(link({ flow: event.currentTarget.value, screen: undefined, el: undefined }), {
						reset: false
					})}
				class="mb-6 h-12 w-full rounded-full border border-neutral-200 bg-white px-5 text-[16px] font-medium lg:hidden dark:border-white/15 dark:bg-night"
			>
				{#each flowGroups as group (group.category ?? '')}
					<optgroup label={group.category ? humanise(group.category) : 'Uncategorised'}>
						{#each group.flows as candidate (candidate.id)}
							<option value={candidate.id}>
								{candidate.title || 'Untitled flow'} ({candidate.steps.length})
							</option>
						{/each}
					</optgroup>
				{/each}
			</select>

			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0">
					<h2 class="text-[28px] leading-tight font-semibold tracking-[-0.035em]">
						{flow.title || 'Untitled flow'}
					</h2>
					<p class="mt-1 text-[16px] text-neutral-500 dark:text-neutral-400">
						{flow.category ? `${humanise(flow.category)} · ` : ''}{data.flowSteps.length}
						{data.flowSteps.length === 1 ? 'screen' : 'screens'}
					</p>
				</div>
				<SaveButton table="flow" id={flow.id} label={flow.title || 'flow'} variant="pill" />
			</div>

			{#if flow.video}
				<!-- A recording of someone going through the flow. The steps below jump to their moment. -->
				{#key flow.id}
					<!-- svelte-ignore a11y_media_has_caption (a screen recording has no audio to caption) -->
					<video
						bind:this={videoElement}
						src="/media/{flow.video.media}"
						controls
						playsinline
						preload="metadata"
						ontimeupdate={(event) =>
							(playback = { flowId: flow.id, time: event.currentTarget.currentTime })}
						class={[
							'mt-6 block scroll-mt-24 rounded-2xl bg-neutral-100 ring-1 ring-black/[0.08] dark:bg-white/5 dark:ring-white/15',
							flow.viewport === 'desktop' && 'w-full max-w-4xl',
							flow.viewport === 'mobile' && 'w-[min(70vw,300px)]'
						]}
						style:aspect-ratio="{flow.video.width} / {flow.video.height}"
					></video>
				{/key}
				{#if flow.video.failed}
					<p class="mt-3 text-[14px] text-neutral-400 dark:text-neutral-500">
						The replay stopped early: {flow.video.failed}.
					</p>
				{/if}
			{/if}

			<!-- The row scrolls sideways and snaps to a screen. On a phone it bleeds to the page edge. -->
			<ol
				bind:this={stepList}
				class="-mx-6 mt-6 flex snap-x snap-mandatory scroll-px-6 gap-5 overflow-x-auto px-6 pb-6 sm:mx-0 sm:scroll-px-0 sm:px-0"
				data-sveltekit-reset="false"
			>
				{#each data.flowSteps as step, index (index)}
					<li
						class={[
							'shrink-0 snap-start',
							step.screen.viewport === 'desktop' && 'w-[min(80vw,380px)]',
							step.screen.viewport === 'mobile' && 'w-[min(56vw,230px)]'
						]}
					>
						<!-- With a video, a step seeks to its moment; the screen itself opens from the link below it. -->
						<a
							href={link({ screen: step.screen.id, flow: flow.id, el: undefined })}
							onclick={(event) => {
								if (seekToStep(flow, index)) event.preventDefault();
							}}
							aria-current={flow.video && index === activeStepOf(flow) ? 'step' : undefined}
							class="group flex flex-col gap-3 rounded-[28px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black dark:focus-visible:outline-white"
						>
							<div
								class={[
									'overflow-hidden bg-white ring-1 ring-black/[0.08] transition-shadow group-hover:ring-black/30 dark:ring-white/15 dark:group-hover:ring-white/40',
									flow.video &&
										index === activeStepOf(flow) &&
										'ring-2 ring-black group-hover:ring-black dark:ring-white dark:group-hover:ring-white',
									step.screen.viewport === 'desktop' && 'rounded-2xl',
									step.screen.viewport === 'mobile' && 'rounded-[26px]'
								]}
								style:aspect-ratio="{step.screen.width} / {step.screen.height}"
							>
								<img
									src="/media/{step.screen.thumb}"
									width={step.screen.width}
									height={step.screen.height}
									alt={step.screen.title || step.screen.path}
									loading="lazy"
									class="size-full object-cover object-top"
								/>
							</div>
							<div class="min-w-0 px-0.5 leading-snug">
								<div class="truncate text-[13px] text-neutral-400 dark:text-neutral-500">
									{index + 1} · {step.screen.path}
								</div>
								<!-- Without a caption from the model the step says how it was reached. -->
								<p class="mt-0.5 line-clamp-4 text-[15px]">
									{#if step.caption}
										{step.caption}
									{:else if step.actionLabel}
										{step.actionKind === 'click' ? 'Clicked' : 'Followed'} “{step.actionLabel}”
									{:else if index === 0}
										Start of the flow
									{:else}
										{step.screen.title || step.screen.path}
									{/if}
								</p>
							</div>
						</a>
						{#if flow.video && flow.video.steps[index] !== undefined}
							<a
								href={link({ screen: step.screen.id, flow: flow.id, el: undefined })}
								class="mt-1 inline-block px-0.5 text-[13px] text-neutral-400 underline-offset-4 hover:underline dark:text-neutral-500"
							>
								Open screen
							</a>
						{/if}
					</li>
				{/each}
			</ol>
		</div>
	</div>
{/snippet}

{#snippet empty(what: 'screens' | 'elements' | 'flows')}
	<div
		class="flex flex-col items-center rounded-[28px] bg-neutral-50 px-6 py-24 text-center dark:bg-white/5"
	>
		<Box class="size-9 text-neutral-300 dark:text-neutral-600" strokeWidth={1.5} />
		<h2 class="mt-5 text-2xl font-semibold tracking-[-0.035em]">
			{activeCrawls.length > 0 ? `Capturing ${what}…` : `No ${what} yet`}
		</h2>
		<p class="mt-2 max-w-sm text-[17px] text-balance text-neutral-500 dark:text-neutral-400">
			{#if what === 'flows'}
				{#if activeCrawls.length > 0}
					They show up here once the crawl has finished.
				{:else}
					No flows were found on the {data.viewport} viewport.
				{/if}
			{:else if filtered}
				No {what} of this kind on the {data.viewport} viewport. Pick another chip, or All.
			{:else if activeCrawls.length > 0}
				They show up here as the crawler finds them.
			{:else}
				Run a crawl for the {data.viewport} viewport to fill this in.
			{/if}
		</p>
	</div>
{/snippet}
