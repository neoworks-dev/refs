<script lang="ts">
	import { ImageOff } from '@lucide/svelte';
	import type { SiteListItem } from '#lib/server/queries.ts';
	import type { Viewport } from '../types.ts';
	import SiteIcon from './SiteIcon.svelte';

	let { site, viewport }: { site: SiteListItem; viewport: Viewport } = $props();

	// Prefer the cover of the selected viewport, then the other one, then a placeholder.
	const shownViewport = $derived<Viewport>(
		site.covers[viewport] ? viewport : viewport === 'desktop' ? 'mobile' : 'desktop'
	);
	const cover = $derived(site.covers[shownViewport]);
</script>

<a
	href="/sites/{site.slug}?viewport={shownViewport}"
	class="group flex flex-col gap-4 rounded-[28px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black dark:focus-visible:outline-white"
>
	<div
		class="relative aspect-[1.22] overflow-hidden rounded-[28px] bg-neutral-100 transition-colors group-hover:bg-neutral-200/70 dark:bg-white/[0.07] dark:group-hover:bg-white/[0.11]"
	>
		{#if site.activeStatus}
			<span
				class="absolute top-4 left-4 z-10 flex items-center gap-2 rounded-full bg-white/85 px-3 py-1.5 text-[13px] font-medium backdrop-blur dark:bg-neutral-800/85"
			>
				<span
					class={[
						'size-2 animate-pulse rounded-full',
						site.activeStatus === 'running' && 'bg-emerald-500',
						site.activeStatus === 'queued' && 'bg-amber-500'
					]}
				></span>
				{site.activeStatus === 'running' ? 'Crawling' : 'Queued'}
			</span>
		{/if}

		<div class="absolute inset-0 flex items-center justify-center">
			{#if cover && shownViewport === 'mobile'}
				<!-- Phone-shaped: height-driven so every phone cover has the same size. -->
				<img
					src="/media/{cover.thumb}"
					width={cover.width}
					height={cover.height}
					alt="{site.name} on mobile"
					loading="lazy"
					class="h-[80%] w-auto rounded-[22px] bg-white object-cover shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.25)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.12)]"
				/>
			{:else if cover}
				<img
					src="/media/{cover.thumb}"
					width={cover.width}
					height={cover.height}
					alt="{site.name} on desktop"
					loading="lazy"
					class="w-[81%] rounded-xl bg-white object-cover shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.25)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.12)]"
				/>
			{:else}
				<div class="flex flex-col items-center gap-2 text-neutral-400 dark:text-neutral-500">
					<ImageOff class="size-7" strokeWidth={1.75} />
					<span class="text-sm">No preview yet</span>
				</div>
			{/if}
		</div>
	</div>

	<div class="flex items-center gap-3 px-0.5">
		<SiteIcon name={site.name} icon={site.icon} class="size-10 rounded-xl" />
		<div class="min-w-0 leading-snug">
			<div class="truncate text-[16px] font-medium">{site.name}</div>
			<div class="truncate text-[15px] text-neutral-500 dark:text-neutral-400">
				{site.description ?? site.host}
			</div>
		</div>
	</div>
</a>
