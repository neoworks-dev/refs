<script lang="ts">
	import { TriangleAlert } from '@lucide/svelte';
	import type { FlowRequest } from '../types.ts';

	// The flows people asked for, with how far each one got. A request is picked up by the worker,
	// which tries it in the site's current crawl and links the flow it captured.
	let { requests, siteSlug }: { requests: FlowRequest[]; siteSlug: string } = $props();
</script>

{#if requests.length > 0}
	<section class="mt-10" aria-label="Requested flows">
		<h2 class="text-[28px] leading-tight font-semibold tracking-[-0.035em]">
			Requested
			<span class="text-[17px] font-normal tracking-normal text-neutral-400 dark:text-neutral-500">
				{requests.length}
			</span>
		</h2>
		<ul class="mt-5 flex flex-col gap-2" aria-live="polite">
			{#each requests as request (request.id)}
				<li
					class={[
						'flex flex-wrap items-center gap-x-5 gap-y-1 rounded-2xl px-5 py-3.5 text-[15px]',
						request.status !== 'failed' && 'bg-neutral-100 dark:bg-white/[0.07]',
						request.status === 'failed' &&
							'bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-200'
					]}
				>
					<span class="flex min-w-0 flex-1 basis-80 flex-col leading-snug">
						<span class="font-medium">{request.goal}</span>
						{#if request.status === 'failed'}
							<span class="mt-0.5 flex items-start gap-2">
								<TriangleAlert class="mt-0.5 size-4 shrink-0" strokeWidth={2} />
								{request.error ?? 'No error message was recorded.'}
							</span>
						{/if}
					</span>
					<span class="flex items-center gap-2.5 font-medium">
						<span
							class={[
								'size-2.5 rounded-full',
								request.status === 'queued' && 'animate-pulse bg-amber-500',
								request.status === 'running' && 'animate-pulse bg-emerald-500',
								request.status === 'done' && 'bg-emerald-500',
								request.status === 'failed' && 'bg-red-500'
							]}
						></span>
						<span class="capitalize">{request.viewport}</span>
						<span class="text-neutral-400 dark:text-neutral-500">·</span>
						<span>
							{#if request.status === 'queued'}
								Queued
							{:else if request.status === 'running'}
								Running
							{:else if request.status === 'failed'}
								Failed
							{:else if request.flow}
								Captured
							{:else}
								Nothing to keep
							{/if}
						</span>
					</span>
					{#if request.flow}
						<a
							href="/sites/{siteSlug}?tab=flows&viewport={request.viewport}&flow={request.flow}"
							class="font-medium underline-offset-4 hover:underline"
						>
							View flow
						</a>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}
