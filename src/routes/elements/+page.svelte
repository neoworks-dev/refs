<script lang="ts">
	import { page } from '$app/state';
	import FilterChips from '#lib/components/FilterChips.svelte';
	import ElementTile from '#lib/components/ElementTile.svelte';
	import SegmentedToggle from '#lib/components/SegmentedToggle.svelte';
	import { humanise, kindLabels, kinds } from '#lib/labels.ts';
	import { SECTION_LABELS } from '#lib/types.ts';
	import { Shapes } from '@lucide/svelte';
	import type { ElementKind } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

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

	const totalElements = $derived(
		Object.values(data.kindCounts).reduce((total, count) => total + count, 0)
	);
</script>

<svelte:head><title>Elements · Refs</title></svelte:head>

<div class="pt-6">
	<h1 class="text-[36px] leading-none font-semibold tracking-[-0.045em] sm:text-[44px]">
		Elements
	</h1>
	<p class="mt-3 max-w-xl text-[17px] text-neutral-500 dark:text-neutral-400">
		UI elements cropped from every site, to compare the same kind of thing side by side.
	</p>

	<div class="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
		<!-- Switching the viewport or the kind starts again from the first page. -->
		<SegmentedToggle
			label="Viewport"
			active={data.viewport}
			options={[
				{
					value: 'desktop',
					label: 'Desktop',
					href: link({ viewport: 'desktop', pages: undefined })
				},
				{ value: 'mobile', label: 'Mobile', href: link({ viewport: 'mobile', pages: undefined }) }
			]}
		/>
		<span class="text-[15px] text-neutral-500 dark:text-neutral-400">
			{totalElements}
			{totalElements === 1 ? 'element' : 'elements'}
		</span>
	</div>

	<div class="mt-6 flex flex-col gap-3">
		<FilterChips
			ariaLabel="Element kind"
			values={kinds}
			counts={data.kindCounts}
			label={(kind) => kindLabels[kind as ElementKind]}
			active={data.kind}
			href={(kind) => link({ kind, label: undefined, pages: undefined })}
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
				href={(label) => link({ label, pages: undefined })}
			/>
		{/if}
	</div>
</div>

{#if data.elements.length > 0}
	<ul
		class="mt-8 grid grid-flow-dense grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
		data-sveltekit-reset="false"
	>
		{#each data.elements as element (element.id)}
			<ElementTile
				{element}
				site={{ name: element.site_name, icon: element.site_icon }}
				href="/sites/{element.site}?viewport={element.viewport}&screen={element.screen}&el={element.id}"
			/>
		{/each}
	</ul>

	{#if data.hasMore}
		<div class="mt-12 flex justify-center" data-sveltekit-reset="false">
			<a
				href={link({ pages: String(data.pages + 1) })}
				class="inline-flex h-12 items-center justify-center rounded-full border border-neutral-200 px-7 text-[16px] font-medium transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:border-white/15 dark:hover:bg-white/10 dark:focus-visible:outline-white"
			>
				Load more
			</a>
		</div>
	{/if}
{:else}
	<div
		class="mt-8 flex flex-col items-center rounded-[28px] bg-neutral-50 px-6 py-24 text-center dark:bg-white/5"
	>
		<Shapes class="size-9 text-neutral-300 dark:text-neutral-600" strokeWidth={1.5} />
		<h2 class="mt-5 text-2xl font-semibold tracking-[-0.035em]">No elements yet</h2>
		<p class="mt-2 max-w-sm text-[17px] text-balance text-neutral-500 dark:text-neutral-400">
			{data.kind
				? 'No element of this kind was captured on this viewport.'
				: 'Elements show up here once a site has been crawled.'}
		</p>
	</div>
{/if}
