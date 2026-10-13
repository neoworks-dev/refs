<script lang="ts">
	import { Pencil, Trash2 } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import CollectionDialog from '#lib/components/CollectionDialog.svelte';
	import ElementTile from '#lib/components/ElementTile.svelte';
	import FilterChips from '#lib/components/FilterChips.svelte';
	import Modal from '#lib/components/Modal.svelte';
	import ScreenCard from '#lib/components/ScreenCard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let editing = $state(false);
	let deleting = $state(false);

	const showScreens = $derived(data.show !== 'elements');
	const showElements = $derived(data.show !== 'screens');
	const desktopScreens = $derived(data.screens.filter((screen) => screen.viewport === 'desktop'));
	const mobileScreens = $derived(data.screens.filter((screen) => screen.viewport === 'mobile'));
	const isEmpty = $derived(data.screens.length + data.elements.length === 0);
</script>

<svelte:head><title>{data.collection.name} · Collections · Refs</title></svelte:head>

<div class="pt-6">
	<a
		href="/collections"
		class="text-[15px] text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-white"
	>
		Collections
	</a>
	<h1
		class="mt-2 text-[36px] leading-[1.05] font-semibold tracking-[-0.045em] break-words sm:text-[44px]"
	>
		{data.collection.name}
	</h1>
	{#if data.collection.description}
		<p class="mt-3 max-w-2xl text-[17px] text-neutral-500 dark:text-neutral-400">
			{data.collection.description}
		</p>
	{/if}

	<div class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
		{#if !isEmpty}
			<FilterChips
				ariaLabel="Show"
				values={['screens', 'elements']}
				counts={{ screens: data.screens.length, elements: data.elements.length }}
				label={(value) => (value === 'screens' ? 'Screens' : 'Elements')}
				active={data.show}
				href={(value) => (value ? `?show=${value}` : '?')}
			/>
		{/if}
		<div class="flex gap-2 sm:ml-auto">
			<button
				type="button"
				onclick={() => (editing = true)}
				class="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-200 px-4 text-[15px] font-medium transition-colors hover:bg-neutral-100 dark:border-white/15 dark:hover:bg-white/10"
			>
				<Pencil class="size-4" strokeWidth={2} />
				Edit
			</button>
			<button
				type="button"
				onclick={() => (deleting = true)}
				class="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-200 px-4 text-[15px] font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-white/15 dark:text-red-400 dark:hover:bg-red-500/10"
			>
				<Trash2 class="size-4" strokeWidth={2} />
				Delete
			</button>
		</div>
	</div>
</div>

{#if isEmpty}
	<div
		class="mt-8 flex flex-col items-center rounded-[28px] bg-neutral-50 px-6 py-24 text-center dark:bg-white/5"
	>
		<h2 class="text-2xl font-semibold tracking-[-0.035em]">Nothing saved yet</h2>
		<p class="mt-2 max-w-sm text-[17px] text-balance text-neutral-500 dark:text-neutral-400">
			Use the bookmark on a screen or an element to put it in this collection.
		</p>
	</div>
{/if}

{#if showScreens && data.screens.length > 0}
	<section class="mt-10" data-sveltekit-reset="false">
		<h2 class="mb-4 text-[20px] font-semibold tracking-[-0.03em]">Screens</h2>
		<!-- Desktop and phone screenshots are different shapes, so each gets its own grid. -->
		{@render screenGrid(desktopScreens, 'desktop')}
		{@render screenGrid(mobileScreens, 'mobile')}
	</section>
{/if}

{#if showElements && data.elements.length > 0}
	<section class="mt-10" data-sveltekit-reset="false">
		<h2 class="mb-4 text-[20px] font-semibold tracking-[-0.03em]">Elements</h2>
		<ul
			class="grid grid-flow-dense grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
		>
			{#each data.elements as element (element.id)}
				<ElementTile
					{element}
					site={{ name: element.site_name, icon: element.site_icon }}
					href="/sites/{element.site}?viewport={element.viewport}&screen={element.screen}&el={element.id}"
				/>
			{/each}
		</ul>
	</section>
{/if}

{#if editing}
	<CollectionDialog
		title="Edit collection"
		action="?/update"
		submitLabel="Save"
		initial={data.collection}
		onclose={() => (editing = false)}
	/>
{/if}

{#if deleting}
	<Modal
		label="Delete collection"
		onclose={() => (deleting = false)}
		class="w-[min(92vw,26rem)] rounded-[2rem] bg-white p-6 text-center shadow-2xl sm:p-8 dark:bg-neutral-900 dark:ring-1 dark:ring-white/10"
	>
		<h2 class="text-[20px] font-semibold tracking-tight">Delete “{data.collection.name}”?</h2>
		<p class="mt-2 text-[15px] text-neutral-500 dark:text-neutral-400">
			The collection is removed for good. The screens and elements in it stay in the library.
		</p>
		<form method="POST" action="?/delete" class="mt-6 grid grid-cols-2 gap-3" use:enhance>
			<button
				type="button"
				onclick={() => (deleting = false)}
				class="h-12 rounded-full border border-neutral-200 text-[16px] font-medium transition-colors hover:bg-neutral-100 dark:border-white/15 dark:hover:bg-white/10"
			>
				Cancel
			</button>
			<button
				type="submit"
				class="h-12 rounded-full bg-red-600 text-[16px] font-medium text-white transition-colors hover:bg-red-700"
			>
				Delete
			</button>
		</form>
	</Modal>
{/if}

{#snippet screenGrid(screens: typeof data.screens, viewport: 'desktop' | 'mobile')}
	{#if screens.length > 0}
		<ul
			class={[
				'grid gap-x-5 gap-y-9 not-first-of-type:mt-10',
				viewport === 'desktop' && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
				viewport === 'mobile' && 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
			]}
		>
			{#each screens as screen (screen.id)}
				<li>
					<ScreenCard
						{screen}
						site={{ name: screen.site_name }}
						href="/sites/{screen.site}?viewport={screen.viewport}&screen={screen.id}"
					/>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}
