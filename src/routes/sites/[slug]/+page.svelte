<script lang="ts">
	import { afterNavigate, goto, invalidate } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Box } from '@lucide/svelte';
	import CrawlStatus from '#lib/components/CrawlStatus.svelte';
	import ElementTile from '#lib/components/ElementTile.svelte';
	import ScreenCard from '#lib/components/ScreenCard.svelte';
	import ScreenViewer from '#lib/components/ScreenViewer.svelte';
	import SegmentedToggle from '#lib/components/SegmentedToggle.svelte';
	import SiteIcon from '#lib/components/SiteIcon.svelte';
	import type { ElementKind, Viewport } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const kindLabels: Record<ElementKind, string> = {
		section: 'Sections',
		header: 'Headers',
		footer: 'Footers',
		nav: 'Navigation',
		button: 'Buttons',
		input: 'Inputs',
		form: 'Forms',
		dialog: 'Dialogs',
		menu: 'Menus',
		table: 'Tables'
	};

	const viewports: Viewport[] = ['desktop', 'mobile'];

	const activeCrawls = $derived(
		data.crawls.filter((crawl) => crawl.status === 'queued' || crawl.status === 'running')
	);
	const totalScreens = $derived(data.screenCounts.desktop + data.screenCounts.mobile);
	const totalElements = $derived(
		viewports
			.flatMap((viewport) => Object.values(data.kindCounts[viewport]))
			.reduce((total, count) => total + count, 0)
	);
	const lastCrawled = $derived(
		data.crawls.find((crawl) => crawl.status === 'done' && crawl.finished_at)?.finished_at
	);
	const kindCounts = $derived(data.kindCounts[data.viewport]);
	// Only kinds that exist on this viewport get a chip; "All" is always there.
	const kindChips = $derived(
		(Object.keys(kindLabels) as ElementKind[]).filter((kind) => (kindCounts[kind] ?? 0) > 0)
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
	<SiteIcon name={data.site.name} icon={data.site.icon} class="size-[92px] rounded-[22px]" />
	<h1 class="mt-5 text-[56px] leading-[1.02] font-semibold tracking-[-0.05em]">{data.site.name}</h1>
	{#if data.site.description}
		<p
			class="mt-3 line-clamp-2 max-w-3xl text-[20px] leading-snug tracking-[-0.01em] text-neutral-500"
		>
			{data.site.description}
		</p>
	{/if}

	<dl class="mt-6 flex flex-wrap gap-x-10 gap-y-4 text-[17px]">
		<div>
			<dt class="text-[15px] text-neutral-500">Viewports</dt>
			<dd class="font-medium">
				<span class="capitalize"
					>{viewports.filter((viewport) => data.sources[viewport]).join(', ')}</span
				>
				{#if !data.sources.desktop && !data.sources.mobile}None yet{/if}
			</dd>
		</div>
		<div>
			<dt class="text-[15px] text-neutral-500">Screens</dt>
			<dd class="font-medium">{totalScreens}</dd>
		</div>
		<div>
			<dt class="text-[15px] text-neutral-500">Elements</dt>
			<dd class="font-medium">{totalElements}</dd>
		</div>
		<div>
			<dt class="text-[15px] text-neutral-500">Last crawled</dt>
			<dd class="font-medium">
				{lastCrawled
					? new Date(lastCrawled).toLocaleDateString('en', { dateStyle: 'medium', timeZone: 'UTC' })
					: 'Never'}
			</dd>
		</div>
		<div>
			<dt class="text-[15px] text-neutral-500">Site</dt>
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
				class="inline-flex h-11 items-center justify-center rounded-full bg-black px-5 text-[15px] font-medium whitespace-nowrap text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
			>
				{activeCrawls.length > 0 ? 'Cancel crawl' : 'Recrawl'}
			</button>
		</form>
		<a
			href={data.site.url}
			target="_blank"
			rel="noopener noreferrer"
			class="inline-flex h-11 items-center justify-center rounded-full border border-neutral-200 bg-white px-5 text-[15px] font-medium whitespace-nowrap transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
		>
			Visit site
		</a>
	</div>

	<CrawlStatus crawls={data.crawls} />
</section>

<div class="mt-10 flex h-14 items-center gap-5 border-b border-neutral-200/70">
	<SegmentedToggle
		label="Viewport"
		active={data.viewport}
		options={[
			// Switching viewport drops the screen and the kind filter: both belong to the old one.
			{
				value: 'desktop',
				label: 'Desktop',
				href: link({ viewport: 'desktop', screen: undefined, el: undefined })
			},
			{
				value: 'mobile',
				label: 'Mobile',
				href: link({ viewport: 'mobile', screen: undefined, el: undefined })
			}
		]}
	/>
	<span class="h-6 w-px bg-neutral-200"></span>
	<nav class="flex h-full items-center gap-7" aria-label="Content" data-sveltekit-reset="false">
		<!-- The active tab's underline sits on the row's bottom border. -->
		{#each [{ value: 'screens', label: 'Screens', href: link( { tab: undefined, kind: undefined } ) }, { value: 'elements', label: 'Elements', href: link( { tab: 'elements' } ) }] as tab (tab.value)}
			<a
				href={tab.href}
				aria-current={data.tab === tab.value ? 'page' : undefined}
				class={[
					'relative flex h-full items-center text-[17px] font-medium tracking-tight transition-colors',
					data.tab === tab.value &&
						'text-black after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-black',
					data.tab !== tab.value && 'text-neutral-400 hover:text-black'
				]}
			>
				{tab.label}
			</a>
		{/each}
		<span
			class="flex h-full cursor-not-allowed items-center text-[17px] font-medium tracking-tight text-neutral-300"
			title="Coming soon"
			aria-disabled="true"
		>
			Flows
		</span>
	</nav>
</div>

<div class="mt-8">
	{#if data.tab === 'screens'}
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
	{:else}
		<div class="mb-8 flex flex-wrap gap-2" data-sveltekit-reset="false">
			<a
				href={link({ kind: undefined })}
				aria-current={data.kind === undefined ? 'true' : undefined}
				class={[
					'inline-flex h-10 items-center rounded-full border px-4 text-[15px] font-medium transition-colors',
					data.kind === undefined && 'border-black bg-black text-white',
					data.kind !== undefined && 'border-neutral-200 hover:bg-neutral-100'
				]}
			>
				All
			</a>
			{#each kindChips as kind (kind)}
				<a
					href={link({ kind })}
					aria-current={data.kind === kind ? 'true' : undefined}
					class={[
						'inline-flex h-10 items-center gap-2 rounded-full border px-4 text-[15px] font-medium transition-colors',
						data.kind === kind && 'border-black bg-black text-white',
						data.kind !== kind && 'border-neutral-200 hover:bg-neutral-100'
					]}
				>
					{kindLabels[kind]}
					<span class={data.kind === kind ? 'text-white/60' : 'text-neutral-400'}>
						{kindCounts[kind]}
					</span>
				</a>
			{/each}
		</div>

		{#if data.elements.length > 0}
			<!-- CSS columns give a masonry layout: tall sections and small buttons both pack tightly. -->
			<ul
				class="columns-1 gap-5 sm:columns-2 lg:columns-3 xl:columns-4"
				data-sveltekit-reset="false"
			>
				{#each data.elements as element (element.id)}
					<li class="mb-7 break-inside-avoid">
						<ElementTile {element} href={link({ screen: element.screen, el: element.id })} />
					</li>
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
		screenHref={(screenId) => link({ screen: screenId, el: undefined })}
		onclose={closeViewer}
		onnavigate={(screenId) =>
			goto(link({ screen: screenId, el: undefined }), { replace: true, reset: false })}
	/>
{/if}

{#snippet empty(what: 'screens' | 'elements')}
	<div class="flex flex-col items-center rounded-[28px] bg-neutral-50 px-6 py-24 text-center">
		<Box class="size-9 text-neutral-300" strokeWidth={1.5} />
		<h2 class="mt-5 text-2xl font-semibold tracking-[-0.035em]">
			{activeCrawls.length > 0 ? `Capturing ${what}…` : `No ${what} yet`}
		</h2>
		<p class="mt-2 max-w-sm text-[17px] text-balance text-neutral-500">
			{#if activeCrawls.length > 0}
				They show up here as the crawler finds them.
			{:else}
				Run a crawl for the {data.viewport} viewport to fill this in.
			{/if}
		</p>
	</div>
{/snippet}
