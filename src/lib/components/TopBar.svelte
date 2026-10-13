<script lang="ts">
	import { Monitor, Moon, Plus, Search, Sun, X } from '@lucide/svelte';
	import { page } from '$app/state';
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

	// The theme is `system` until the user picks one. app.html applies it before the first paint;
	// this applies later changes, and follows the system preference live while there is no
	// explicit choice. Only an explicit choice is stored.
	const THEME_KEY = 'refs:theme';
	const THEMES = ['system', 'light', 'dark'] as const;
	type Theme = (typeof THEMES)[number];
	let theme = $state<Theme>('system');
	onMount(() => {
		const stored = localStorage.getItem(THEME_KEY);
		if (stored === 'light' || stored === 'dark') theme = stored;
	});

	$effect(() => {
		const query = matchMedia('(prefers-color-scheme: dark)');
		const apply = () =>
			document.documentElement.classList.toggle(
				'dark',
				theme === 'system' ? query.matches : theme === 'dark'
			);
		apply();
		query.addEventListener('change', apply);
		return () => query.removeEventListener('change', apply);
	});

	const themeLabel = $derived(
		{ system: 'System theme', light: 'Light theme', dark: 'Dark theme' }[theme]
	);

	function cycleTheme() {
		theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
		if (theme === 'system') localStorage.removeItem(THEME_KEY);
		else localStorage.setItem(THEME_KEY, theme);
	}
</script>

<header class="sticky top-0 z-30 bg-white/90 backdrop-blur-md dark:bg-night/90">
	<!-- Below 1024px the search collapses into an icon next to the buttons on the right. -->
	<div
		class="mx-auto flex h-[68px] max-w-[1920px] items-center gap-3 px-6 sm:px-8 lg:grid lg:h-[76px] lg:grid-cols-[1fr_minmax(0,34rem)_1fr] lg:gap-6 lg:px-10"
	>
		<div class="flex items-center gap-5 sm:gap-8">
			<!-- "Refs" wordmark: three stacked bars (a pile of references) next to the name. -->
			<a
				href="/"
				class="flex items-center gap-2.5 text-black dark:text-white"
				aria-label="Refs home"
			>
				<svg viewBox="0 0 28 28" class="size-7" aria-hidden="true">
					<rect x="1" y="3" width="26" height="6.5" rx="3.25" fill="currentColor" />
					<rect x="1" y="11.25" width="17" height="6.5" rx="3.25" fill="currentColor" />
					<rect x="1" y="19.5" width="22" height="6.5" rx="3.25" fill="currentColor" />
				</svg>
				<span class="text-[22px] font-semibold tracking-[-0.04em] max-sm:hidden">Refs</span>
			</a>
			<nav
				class="flex items-center gap-4 text-[16px] font-medium tracking-tight sm:gap-6 sm:text-[17px]"
			>
				{#each [{ href: '/', label: 'Sites', active: page.url.pathname === '/' || page.url.pathname.startsWith('/sites/') }, { href: '/elements', label: 'Elements', active: page.url.pathname === '/elements' }] as link (link.href)}
					<a
						href={link.href}
						aria-current={link.active ? 'page' : undefined}
						class={[
							'transition-colors',
							link.active && 'text-black dark:text-white',
							!link.active &&
								'text-neutral-400 hover:text-black dark:text-neutral-500 dark:hover:text-white'
						]}
					>
						{link.label}
					</a>
				{/each}
			</nav>
		</div>

		<button
			type="button"
			onclick={() => (paletteOpen = true)}
			aria-label="Search"
			class="flex size-11 items-center justify-center rounded-full bg-neutral-100 text-black transition-colors hover:bg-neutral-200/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black max-lg:ml-auto lg:h-[46px] lg:w-full lg:justify-start lg:gap-3.5 lg:px-5 dark:bg-white/[0.08] dark:text-white dark:hover:bg-white/[0.12] dark:focus-visible:outline-white"
		>
			<Search class="size-[19px] shrink-0" strokeWidth={2.25} />
			<span
				class="hidden flex-1 text-left text-[17px] text-neutral-400 lg:block dark:text-neutral-500"
			>
				Search sites, screens, elements…
			</span>
			<kbd
				class="hidden shrink-0 rounded-md border border-neutral-300 bg-white px-1.5 py-0.5 font-sans text-xs font-medium text-neutral-400 lg:block dark:border-white/15 dark:bg-transparent dark:text-neutral-500"
			>
				{shortcut}
			</kbd>
		</button>

		<div class="flex items-center justify-end gap-3">
			<!-- Cycles system, light and dark. The icon shows what is active right now. -->
			<button
				type="button"
				onclick={cycleTheme}
				aria-label="{themeLabel}, click to change"
				title={themeLabel}
				class="flex size-11 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:outline-white"
			>
				{#if theme === 'system'}
					<Monitor class="size-5" strokeWidth={2} />
				{:else if theme === 'light'}
					<Sun class="size-5" strokeWidth={2} />
				{:else}
					<Moon class="size-5" strokeWidth={2} />
				{/if}
			</button>
			<!-- Without JS this is a plain link to the standalone /add page. Below 640px it is just the plus. -->
			<a
				href="/add"
				aria-label="Add site"
				onclick={(event) => {
					event.preventDefault();
					addDialogOpen = true;
				}}
				class="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-black px-5 text-[15px] font-medium whitespace-nowrap text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black max-sm:w-11 max-sm:px-0 dark:bg-white dark:text-black dark:hover:bg-neutral-200 dark:focus-visible:outline-white"
			>
				<Plus class="size-[18px] sm:-ml-1" strokeWidth={2.5} />
				<span class="max-sm:hidden">Add site</span>
			</a>
		</div>
	</div>
</header>

<SearchPalette bind:open={paletteOpen} />

{#if addDialogOpen}
	<Modal
		label="Add site"
		onclose={() => (addDialogOpen = false)}
		class="w-[min(92vw,34rem)] rounded-[2rem] bg-white px-6 pt-16 pb-8 shadow-2xl sm:px-10 sm:pb-10 dark:bg-neutral-900 dark:ring-1 dark:ring-white/10"
	>
		<button
			type="button"
			aria-label="Close"
			onclick={() => (addDialogOpen = false)}
			class="absolute top-5 right-5 flex size-10 items-center justify-center rounded-full bg-neutral-100 transition-colors hover:bg-neutral-200 dark:bg-white/10 dark:hover:bg-white/20"
		>
			<X class="size-[18px]" strokeWidth={2.25} />
		</button>
		<AddSiteForm onsuccess={() => (addDialogOpen = false)} />
	</Modal>
{/if}
