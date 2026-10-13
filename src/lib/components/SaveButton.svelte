<script lang="ts">
	import { Bookmark, Check, Plus } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { savedKey, type SavedTable } from '#lib/saved.ts';

	type Props = {
		table: SavedTable;
		id: string;
		/** Names the thing for screen readers, as in "Save pricing to a collection". */
		label: string;
		/** `overlay` is the round button on a card's corner; `pill` sits in a toolbar with a label. */
		variant: 'overlay' | 'pill';
	};

	let { table, id, label, variant }: Props = $props();

	const instance = $props.id();
	const popoverId = `save-${instance}`;
	// The popover is placed against its button with CSS anchor positioning, so it needs no
	// measuring in JS and follows the button when the page scrolls. The name must be unique.
	const anchorName = `--save-${instance}`;

	const collections = $derived(page.data.collections);
	const holders = $derived(page.data.savedIn[savedKey(table, id)] ?? []);

	let creating = $state(false);
</script>

<button
	type="button"
	popovertarget={popoverId}
	aria-label={`Save ${label} to a collection`}
	style:anchor-name={anchorName}
	class={[
		'transition-[opacity,background-color] focus-visible:outline-2 focus-visible:outline-offset-2',
		variant === 'overlay' &&
			'absolute top-3 right-3 z-10 flex size-10 items-center justify-center rounded-full bg-white text-black shadow-[0_2px_8px_rgb(0_0_0/0.2)] hover:bg-neutral-100 aria-expanded:opacity-100 dark:bg-neutral-800 dark:text-white dark:hover:bg-neutral-700',
		// Hover reveals the button, but a saved card always shows it and a touch screen has no hover.
		variant === 'overlay' &&
			holders.length === 0 &&
			'opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100',
		variant === 'pill' &&
			'inline-flex h-11 items-center justify-center gap-2 rounded-full border border-neutral-200 bg-white px-5 text-[15px] font-medium whitespace-nowrap hover:bg-neutral-100 max-sm:w-11 max-sm:px-0 dark:border-white/15 dark:bg-transparent dark:hover:bg-white/10'
	]}
>
	<Bookmark
		class={variant === 'overlay' ? 'size-[18px]' : 'size-4 sm:-ml-1'}
		fill={holders.length > 0 ? 'currentColor' : 'none'}
		strokeWidth={2}
	/>
	{#if variant === 'pill'}
		<span class="max-sm:hidden">{holders.length > 0 ? 'Saved' : 'Save'}</span>
	{/if}
</button>

<!-- Below 640px the picker is a sheet along the bottom edge, which a thumb reaches. Wider, it opens
under its button, or above it when there is no room below. -->
<div
	id={popoverId}
	popover="auto"
	aria-label="Save to collection"
	ontoggle={(event) => {
		if (event.newState === 'closed') creating = false;
	}}
	style:position-anchor={anchorName}
	class="popover-open:flex inset-auto my-2 max-h-[min(26rem,70dvh)] w-72 flex-col overflow-hidden rounded-3xl bg-white p-2 text-black shadow-2xl ring-1 ring-black/10 [position-area:bottom_span-left] [position-try-fallbacks:flip-block] max-sm:inset-x-3 max-sm:bottom-3 max-sm:my-0 max-sm:w-auto max-sm:[position-area:none] dark:bg-neutral-900 dark:text-white dark:ring-white/10"
>
	<h2 class="px-3 pt-2 pb-2 text-[13px] font-medium text-neutral-500 dark:text-neutral-400">
		Save to collection
	</h2>

	<ul class="min-h-0 overflow-y-auto">
		{#each collections as collection (collection.id)}
			{@const isSaved = holders.includes(collection.id)}
			<li>
				<!-- Each row is its own form so saving works without JavaScript. The form says the
				state it wants rather than "toggle", so a repeated submit changes nothing. -->
				<form
					method="POST"
					action="/collections?/toggle"
					use:enhance={() =>
						async ({ update }) => {
							// The action lives on /collections; without `navigate: false` Kit 3 would
							// follow the form there, like a browser does for a plain submit.
							await update({ reset: false, navigate: false });
						}}
				>
					<input type="hidden" name="collection" value={collection.id} />
					<input type="hidden" name="table" value={table} />
					<input type="hidden" name="id" value={id} />
					<input type="hidden" name="saved" value={String(!isSaved)} />
					<button
						type="submit"
						aria-pressed={isSaved}
						class="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-white/10"
					>
						<span class="min-w-0 flex-1 leading-tight">
							<span class="block truncate text-[15px] font-medium">{collection.name}</span>
							<span class="block text-[13px] text-neutral-500 dark:text-neutral-400">
								{collection.count}
								{collection.count === 1 ? 'item' : 'items'}
							</span>
						</span>
						<span
							class={[
								'flex size-6 shrink-0 items-center justify-center rounded-full',
								isSaved && 'bg-black text-white dark:bg-white dark:text-black',
								!isSaved && 'border border-neutral-300 dark:border-white/25'
							]}
						>
							{#if isSaved}<Check class="size-3.5" strokeWidth={3} />{/if}
						</span>
					</button>
				</form>
			</li>
		{/each}
	</ul>

	<div
		class={[
			'mt-1 border-t border-neutral-200 pt-1 dark:border-white/10',
			collections.length === 0 && 'mt-0 border-t-0 pt-0'
		]}
	>
		{#if creating}
			<form
				method="POST"
				action="/collections?/create"
				class="flex items-center gap-2 p-1"
				use:enhance={() =>
					async ({ result, update }) => {
						await update({ navigate: false });
						if (result.type === 'success') creating = false;
					}}
			>
				<input type="hidden" name="table" value={table} />
				<input type="hidden" name="id" value={id} />
				<!-- Autofocus is the point: the user just asked to name something. -->
				<!-- svelte-ignore a11y_autofocus -->
				<input
					name="name"
					required
					autofocus
					autocomplete="off"
					placeholder="Collection name"
					aria-label="Collection name"
					class="h-10 min-w-0 flex-1 rounded-full border-0 bg-neutral-100 px-4 text-[15px] placeholder:text-neutral-400 focus:ring-2 focus:ring-black dark:bg-white/[0.08] dark:focus:ring-white"
				/>
				<button
					type="submit"
					class="h-10 rounded-full bg-black px-4 text-[15px] font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
				>
					Create
				</button>
			</form>
		{:else}
			<button
				type="button"
				onclick={() => (creating = true)}
				class="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-[15px] font-medium transition-colors hover:bg-neutral-100 dark:hover:bg-white/10"
			>
				<Plus class="size-[18px]" strokeWidth={2.25} />
				New collection
			</button>
		{/if}
	</div>
</div>
