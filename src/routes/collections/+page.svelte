<script lang="ts">
	import { Plus } from '@lucide/svelte';
	import CollectionDialog from '#lib/components/CollectionDialog.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let creating = $state(false);
</script>

<svelte:head><title>Collections · Refs</title></svelte:head>

<div class="pt-6">
	<h1 class="text-[36px] leading-none font-semibold tracking-[-0.045em] sm:text-[44px]">
		Collections
	</h1>
	<p class="mt-3 max-w-xl text-[17px] text-neutral-500 dark:text-neutral-400">
		Screens, elements and flows kept together, like the pricing pages for one project.
	</p>
</div>

{#if data.items.length === 0}
	<div
		class="mt-8 flex flex-col items-center rounded-[28px] bg-neutral-50 px-6 py-24 text-center dark:bg-white/5"
	>
		<h2 class="text-2xl font-semibold tracking-[-0.035em]">Gather your inspiration</h2>
		<p class="mt-2 max-w-sm text-[17px] text-balance text-neutral-500 dark:text-neutral-400">
			Save anything you find interesting from its card or the viewer, and organise it into
			collections.
		</p>
		<button
			type="button"
			onclick={() => (creating = true)}
			class="mt-7 inline-flex h-12 items-center rounded-full bg-black px-6 text-[16px] font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
		>
			Create collection
		</button>
	</div>
{:else}
	<ul
		class="mt-8 grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
	>
		{#each data.items as collection (collection.id)}
			<li>
				<a
					href="/collections/{collection.slug}"
					class="group flex flex-col gap-3 rounded-[28px] focus-visible:outline-2 focus-visible:outline-offset-4"
				>
					<div
						class="relative aspect-[0.85] overflow-hidden rounded-3xl bg-neutral-100 transition-colors group-hover:bg-neutral-200/70 dark:bg-white/[0.07] dark:group-hover:bg-white/[0.11]"
					>
						{#if collection.count > 1}
							<!-- Edges of the items underneath, so a card with several reads as a pile. -->
							<div
								class="absolute inset-x-8 top-2 h-6 rounded-t-2xl bg-neutral-200 dark:bg-white/[0.08]"
							></div>
						{/if}
						{#if collection.cover?.table === 'screen'}
							<!-- A phone screenshot hangs from the top and is cut off at the bottom, like Mobbin's
							cards. A desktop one is small enough to show whole. -->
							<img
								src="/media/{collection.cover.thumb}"
								alt=""
								width={collection.cover.width}
								height={collection.cover.height}
								loading="lazy"
								class={[
									'absolute bg-white object-cover object-top shadow-[0_0_0_1px_rgb(0_0_0/0.06)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.12)]',
									collection.cover.viewport === 'mobile' &&
										'top-4 left-[14%] w-[72%] rounded-t-2xl',
									collection.cover.viewport === 'desktop' &&
										'top-1/2 left-[7%] w-[86%] -translate-y-1/2 rounded-lg'
								]}
							/>
						{:else if collection.cover?.table === 'element'}
							<div class="absolute inset-0 flex items-center justify-center p-5">
								<img
									src="/media/{collection.cover.media}"
									alt=""
									loading="lazy"
									class="max-h-full max-w-full rounded-lg bg-white object-contain shadow-[0_0_0_1px_rgb(0_0_0/0.06)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1)]"
									style:width="{collection.cover.rect.w}px"
								/>
							</div>
						{:else}
							<div
								class="absolute inset-0 flex items-center justify-center text-[15px] text-neutral-400 dark:text-neutral-500"
							>
								Empty
							</div>
						{/if}
					</div>
					<div class="min-w-0 px-0.5 leading-snug">
						<div class="truncate text-[16px] font-medium">{collection.name}</div>
						<div class="text-[14px] text-neutral-500 dark:text-neutral-400">
							{collection.count}
							{collection.count === 1 ? 'item' : 'items'}
						</div>
					</div>
				</a>
			</li>
		{/each}
		<li>
			<button
				type="button"
				onclick={() => (creating = true)}
				class="flex aspect-[0.85] w-full flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-neutral-200 text-[16px] font-medium text-neutral-500 transition-colors hover:border-neutral-300 hover:text-black dark:border-white/15 dark:text-neutral-400 dark:hover:border-white/30 dark:hover:text-white"
			>
				<Plus class="size-6" strokeWidth={2} />
				New collection
			</button>
		</li>
	</ul>
{/if}

{#if creating}
	<CollectionDialog
		title="New collection"
		action="/collections?/create"
		submitLabel="Create"
		onclose={() => (creating = false)}
	/>
{/if}
