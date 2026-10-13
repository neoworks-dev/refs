<script lang="ts">
	import { TriangleAlert } from '@lucide/svelte';
	import type { Crawl } from '../types.ts';

	// Live strip for queued/running crawls, plus the error of a crawl that failed most recently.
	let { crawls }: { crawls: Crawl[] } = $props();

	// Sorted by viewport so the order does not flip when two crawls were created in the same instant.
	const active = $derived(
		crawls
			.filter((crawl) => crawl.status === 'queued' || crawl.status === 'running')
			.sort((first, second) => first.viewport.localeCompare(second.viewport))
	);
	// Newest crawl per viewport; a failure only matters while nothing newer has replaced it.
	const failed = $derived(
		(['desktop', 'mobile'] as const)
			.map((viewport) => crawls.find((crawl) => crawl.viewport === viewport))
			.filter((crawl): crawl is Crawl => crawl?.status === 'failed')
	);
</script>

{#if active.length > 0 || failed.length > 0}
	<div class="mt-8 flex flex-col gap-2" aria-live="polite">
		{#each active as crawl (crawl.id)}
			<div
				class="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-2xl bg-neutral-100 px-5 py-3.5 text-[15px] dark:bg-white/[0.07]"
			>
				<span class="flex items-center gap-2.5 font-medium">
					<span
						class={[
							'size-2.5 animate-pulse rounded-full',
							crawl.status === 'running' && 'bg-emerald-500',
							crawl.status === 'queued' && 'bg-amber-500'
						]}
					></span>
					<span>
						<span class="capitalize">{crawl.viewport}</span> · {crawl.status === 'running'
							? 'Crawling'
							: 'Queued'}
					</span>
				</span>
				<span class="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400">
					{crawl.activity ??
						(crawl.status === 'queued' ? 'Waiting for the crawler to pick this up…' : 'Starting…')}
				</span>
				<span class="text-neutral-500 tabular-nums dark:text-neutral-400">
					{crawl.screens} of {crawl.max_screens} screens · {crawl.elements} elements
				</span>
			</div>
		{/each}
		{#each failed as crawl (crawl.id)}
			<div
				class="flex items-start gap-3 rounded-2xl bg-red-50 px-5 py-3.5 text-[15px] text-red-900 dark:bg-red-500/10 dark:text-red-200"
			>
				<TriangleAlert class="mt-0.5 size-[18px] shrink-0" strokeWidth={2} />
				<span>
					<span class="font-medium"
						><span class="capitalize">{crawl.viewport}</span> crawl failed.</span
					>
					{crawl.error ?? 'No error message was recorded.'}
				</span>
			</div>
		{/each}
	</div>
{/if}
