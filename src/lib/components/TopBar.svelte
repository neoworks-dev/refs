<script lang="ts">
	import { Plus, Search, X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import AddSiteForm from './AddSiteForm.svelte';
	import Modal from './Modal.svelte';
	import SearchPalette from './SearchPalette.svelte';

	let addDialogOpen = $state(false);
	let paletteOpen = $state(false);

	// The shortcut hint names the key the user actually has. Ctrl is the server-rendered default.
	let shortcut = $state('Ctrl K');
	onMount(() => {
		if (/Mac|iPhone|iPad/.test(navigator.userAgent)) shortcut = '⌘K';
	});
</script>

<header class="sticky top-0 z-30 bg-white/90 backdrop-blur-md">
	<!-- Below 1024px the search collapses into an icon next to the button on the right. -->
	<div
		class="mx-auto flex h-[68px] max-w-[1920px] items-center gap-3 px-6 sm:px-8 lg:grid lg:h-[76px] lg:grid-cols-[1fr_minmax(0,34rem)_1fr] lg:gap-6 lg:px-10"
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

		<button
			type="button"
			onclick={() => (paletteOpen = true)}
			aria-label="Search"
			class="flex size-11 items-center justify-center rounded-full bg-neutral-100 text-black transition-colors hover:bg-neutral-200/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black max-lg:ml-auto lg:h-[46px] lg:w-full lg:justify-start lg:gap-3.5 lg:px-5"
		>
			<Search class="size-[19px] shrink-0" strokeWidth={2.25} />
			<span class="hidden flex-1 text-left text-[17px] text-neutral-400 lg:block">
				Search sites, screens, elements…
			</span>
			<kbd
				class="hidden shrink-0 rounded-md border border-neutral-300 bg-white px-1.5 py-0.5 font-sans text-xs font-medium text-neutral-400 lg:block"
			>
				{shortcut}
			</kbd>
		</button>

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

<SearchPalette bind:open={paletteOpen} />

{#if addDialogOpen}
	<Modal
		label="Add site"
		onclose={() => (addDialogOpen = false)}
		class="w-[min(92vw,34rem)] rounded-[2rem] bg-white px-6 pt-16 pb-8 shadow-2xl sm:px-10 sm:pb-10"
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
