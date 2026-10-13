<script lang="ts">
	import { Plus, X } from '@lucide/svelte';
	import { page } from '$app/state';
	import SegmentedToggle from '#lib/components/SegmentedToggle.svelte';
	import SiteCard from '#lib/components/SiteCard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// "No sites at all" and "no match for the search" are different empty states.
	const searching = $derived(data.query.trim() !== '');

	// A toggle link keeps the search term and only changes the viewport.
	function viewportHref(viewport: 'desktop' | 'mobile') {
		const params = new URLSearchParams(page.url.searchParams.toString());
		params.set('viewport', viewport);
		return `/?${params}`;
	}

	// The search palette no longer filters this page, but `/?q=` still does, so a link into it
	// has to show what it is filtering by and a way out.
	const clearSearchHref = $derived(`/?viewport=${data.viewport}`);
</script>

<svelte:head><title>Sites · Refs</title></svelte:head>

<div class="pt-6">
	<h1 class="text-[36px] leading-none font-semibold tracking-[-0.045em] sm:text-[44px]">Sites</h1>

	<div class="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
		<SegmentedToggle
			label="Viewport"
			active={data.viewport}
			options={[
				{ value: 'desktop', label: 'Desktop', href: viewportHref('desktop') },
				{ value: 'mobile', label: 'Mobile', href: viewportHref('mobile') }
			]}
		/>
		{#if searching}
			<a
				href={clearSearchHref}
				aria-label="Clear search"
				class="inline-flex h-10 max-w-full items-center gap-2 rounded-full border border-neutral-200 pr-3 pl-4 text-[15px] font-medium transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:border-white/15 dark:hover:bg-white/10 dark:focus-visible:outline-white"
			>
				<span class="truncate">“{data.query.trim()}”</span>
				<X class="size-4 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={2.25} />
			</a>
		{/if}
		{#if data.sites.length > 0}
			<span class="text-[15px] text-neutral-500 dark:text-neutral-400">
				{data.sites.length}
				{data.sites.length === 1 ? 'site' : 'sites'}
			</span>
		{/if}
	</div>
</div>

{#if data.sites.length > 0}
	<ul class="mt-8 grid grid-cols-1 gap-x-5 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
		{#each data.sites as site (site.id)}
			<li><SiteCard {site} viewport={data.viewport} /></li>
		{/each}
	</ul>
{:else}
	<div class="flex flex-col items-center px-2 pt-20 text-center sm:px-6 sm:pt-28">
		<!-- Three ghosted cards, echoing Mobbin's empty state. -->
		<div class="relative h-[104px] w-[132px]" aria-hidden="true">
			<div
				class="absolute bottom-0 left-0 h-[84px] w-[56px] -rotate-[8deg] rounded-2xl bg-neutral-100 dark:bg-white/[0.07]"
			></div>
			<div
				class="absolute right-0 bottom-0 h-[84px] w-[56px] rotate-[8deg] rounded-2xl bg-neutral-100 dark:bg-white/[0.07]"
			></div>
			<div
				class="absolute bottom-0 left-1/2 h-[104px] w-[60px] -translate-x-1/2 rounded-2xl bg-neutral-200 dark:bg-white/15"
			>
				<div class="mx-auto mt-3.5 size-4 rounded-full bg-white/80 dark:bg-white/30"></div>
				<div class="mx-3 mt-3 h-1 rounded-full bg-white/80 dark:bg-white/30"></div>
				<div class="mx-3 mt-1.5 h-1 w-6 rounded-full bg-white/80 dark:bg-white/30"></div>
			</div>
		</div>

		<h2 class="mt-8 text-2xl font-semibold tracking-[-0.035em]">
			{searching ? `No sites match “${data.query}”` : 'Collect your first reference'}
		</h2>
		<p class="mt-3 max-w-sm text-[17px] text-neutral-500 dark:text-neutral-400">
			{#if searching}
				Search looks at names, hosts and descriptions. Try a shorter term, or add this site.
			{:else}
				Add a website and we'll capture its screens, states and UI elements for you to browse here.
			{/if}
		</p>

		<div class="mt-8 flex flex-wrap justify-center gap-3">
			{#if searching}
				<a
					href={clearSearchHref}
					class="inline-flex h-11 items-center justify-center rounded-full border border-neutral-200 bg-white px-5 text-[15px] font-medium transition-colors hover:bg-neutral-100 dark:border-white/15 dark:bg-transparent dark:hover:bg-white/10"
				>
					Clear search
				</a>
			{/if}
			<a
				href="/add"
				class="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-black px-5 text-[15px] font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
			>
				<Plus class="-ml-1 size-[18px]" strokeWidth={2.5} />
				Add site
			</a>
		</div>
	</div>
{/if}
