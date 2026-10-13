<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Plus, Search, X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import AddSiteForm from './AddSiteForm.svelte';
	import Modal from './Modal.svelte';

	// Search lives in the URL (`/?q=`), so the bar always submits to the discover page. Typing
	// filters live after a short pause; the real form submit keeps it working without JS.
	// Follows the URL (back button, clearing the search elsewhere) and is overwritten while typing.
	let query = $derived(page.url.pathname === '/' ? (page.url.searchParams.get('q') ?? '') : '');
	let input: HTMLInputElement | undefined = $state();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let addDialogOpen = $state(false);

	function search(value: string) {
		const params = new URLSearchParams();
		if (value.trim()) params.set('q', value.trim());
		const viewport = page.url.searchParams.get('viewport');
		if (viewport && page.url.pathname === '/') params.set('viewport', viewport);
		const suffix = params.size > 0 ? `?${params}` : '';
		goto(`/${suffix}`, { reset: false, replace: page.url.pathname === '/' });
	}

	function oninput() {
		clearTimeout(timer);
		timer = setTimeout(() => search(query), 220);
	}

	onMount(() => {
		// "/" jumps to the search field, like most documentation and gallery sites.
		function onkeydown(event: KeyboardEvent) {
			const target = event.target as HTMLElement;
			const typing = target.matches('input, textarea, select, [contenteditable]');
			if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
				event.preventDefault();
				input?.focus();
			}
		}
		window.addEventListener('keydown', onkeydown);
		return () => window.removeEventListener('keydown', onkeydown);
	});
</script>

<header class="sticky top-0 z-30 bg-white/90 backdrop-blur-md">
	<div
		class="mx-auto grid h-[76px] max-w-[1920px] grid-cols-[1fr_minmax(0,34rem)_1fr] items-center gap-6 px-6 sm:px-8 lg:px-10"
	>
		<div class="flex items-center gap-8">
			<!-- "Refs" wordmark: three stacked bars (a pile of references) next to the name. -->
			<a href="/" class="flex items-center gap-2.5 text-black" aria-label="Refs home">
				<svg viewBox="0 0 28 28" class="size-7" aria-hidden="true">
					<rect x="1" y="3" width="26" height="6.5" rx="3.25" fill="currentColor" />
					<rect x="1" y="11.25" width="17" height="6.5" rx="3.25" fill="currentColor" />
					<rect x="1" y="19.5" width="22" height="6.5" rx="3.25" fill="currentColor" />
				</svg>
				<span class="text-[22px] font-semibold tracking-[-0.04em]">Refs</span>
			</a>
			<nav class="hidden items-center gap-6 text-[17px] font-medium tracking-tight sm:flex">
				<a href="/" class="text-black">Sites</a>
			</nav>
		</div>

		<form
			action="/"
			method="GET"
			role="search"
			class="relative"
			onsubmit={(event) => {
				event.preventDefault();
				clearTimeout(timer);
				search(query);
			}}
		>
			<Search
				class="pointer-events-none absolute top-1/2 left-5 size-[19px] -translate-y-1/2 text-black"
				strokeWidth={2.25}
			/>
			<input
				bind:this={input}
				bind:value={query}
				{oninput}
				type="search"
				name="q"
				placeholder="Search sites…"
				autocomplete="off"
				aria-label="Search sites"
				class="h-[46px] w-full rounded-full border-0 bg-neutral-100 pr-12 pl-[52px] text-[17px] text-black placeholder:text-neutral-400 focus:bg-neutral-100 focus:ring-2 focus:ring-black focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
			/>
			<kbd
				class="pointer-events-none absolute top-1/2 right-4 hidden size-6 -translate-y-1/2 items-center justify-center rounded-md border border-neutral-300 bg-white text-xs font-medium text-neutral-400 sm:flex"
			>
				/
			</kbd>
		</form>

		<div class="flex items-center justify-end gap-3">
			<!-- Without JS this is a plain link to the standalone /add page. -->
			<a
				href="/add"
				onclick={(event) => {
					event.preventDefault();
					addDialogOpen = true;
				}}
				class="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-black px-5 text-[15px] font-medium whitespace-nowrap text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
			>
				<Plus class="-ml-1 size-[18px]" strokeWidth={2.5} />
				Add site
			</a>
		</div>
	</div>
</header>

{#if addDialogOpen}
	<Modal
		label="Add site"
		onclose={() => (addDialogOpen = false)}
		class="w-[min(92vw,34rem)] rounded-[2rem] bg-white px-10 pt-16 pb-10 shadow-2xl"
	>
		<button
			type="button"
			aria-label="Close"
			onclick={() => (addDialogOpen = false)}
			class="absolute top-5 right-5 flex size-10 items-center justify-center rounded-full bg-neutral-100 transition-colors hover:bg-neutral-200"
		>
			<X class="size-[18px]" strokeWidth={2.25} />
		</button>
		<AddSiteForm onsuccess={() => (addDialogOpen = false)} />
	</Modal>
{/if}
