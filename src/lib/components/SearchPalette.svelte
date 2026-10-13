<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { CornerDownLeft, LoaderCircle, Search, SearchX } from '@lucide/svelte';
	import type { SearchResults, SemanticResults, SemanticScreenHit } from '#lib/server/queries.ts';
	import { humanise } from '../labels.ts';
	import type { Rect, Site } from '../types.ts';
	import Modal from './Modal.svelte';
	import SiteIcon from './SiteIcon.svelte';

	// The command palette: one search over sites, screens and elements. Always mounted so it can
	// own the shortcuts and remember which sites were visited; the dialog only exists while open.
	let { open = $bindable(false) }: { open: boolean } = $props();

	type RecentSite = Pick<Site, 'slug' | 'name' | 'host' | 'icon'>;

	const RECENT_KEY = 'refs:recent-sites';
	// Enough to jump back to the last few sites without the empty state turning into a list.
	const RECENT_LIMIT = 6;
	// Short enough to feel instant, long enough to skip the request for every keystroke.
	const SEARCH_DELAY_MS = 120;
	// Matching by meaning embeds the query on the GPU, so it waits for a real pause in typing
	// instead of running for every few keystrokes.
	const MEANING_DELAY_MS = 400;

	let query = $state('');
	let results = $state<SearchResults>();
	let meaning = $state<SemanticResults>();
	let loading = $state(false);
	let meaningLoading = $state(false);
	let failed = $state(false);
	let activeIndex = $state(0);

	// Storage is not reactive, so the list is read again each time the palette opens.
	const recents = $derived.by(() => (open ? readRecents() : []));
	const searching = $derived(query.trim() !== '');

	// Result links in display order; the keyboard moves through this list.
	const hrefs = $derived.by(() => {
		if (!searching) return recents.map((site) => `/sites/${site.slug}`);
		if (!results) return [];
		return [
			...results.sites.map((site) => `/sites/${site.slug}`),
			...results.screens.map(
				(screen) => `/sites/${screen.site}?viewport=${screen.viewport}&screen=${screen.id}`
			),
			...results.elements.map(
				(element) =>
					`/sites/${element.site}?viewport=${element.viewport}&screen=${element.screen}&el=${element.id}`
			),
			...(meaning?.screens ?? []).map(
				(screen) => `/sites/${screen.site}?viewport=${screen.viewport}&screen=${screen.id}`
			),
			...(meaning?.sections ?? []).map(
				(section) =>
					`/sites/${section.site}?viewport=${section.viewport}&screen=${section.screen}&el=${section.id}`
			)
		];
	});
	const screenOffset = $derived(results?.sites.length ?? 0);
	const elementOffset = $derived(screenOffset + (results?.screens.length ?? 0));
	const meaningScreenOffset = $derived(elementOffset + (results?.elements.length ?? 0));
	const meaningSectionOffset = $derived(meaningScreenOffset + (meaning?.screens.length ?? 0));

	function readRecents(): RecentSite[] {
		try {
			return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
		} catch (error) {
			// Only a hand-edited or truncated value is expected here; start over instead of failing.
			if (error instanceof SyntaxError) return [];
			throw error;
		}
	}

	// Remember every site the user looks at, newest first.
	$effect(() => {
		const site = (page.data as { site?: Site }).site;
		if (!site) return;
		const others = readRecents().filter((recent) => recent.slug !== site.slug);
		const entry = { slug: site.slug, name: site.name, host: site.host, icon: site.icon };
		localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...others].slice(0, RECENT_LIMIT)));
	});

	// Fetch results shortly after typing stops. Leaving the effect cancels the pending request,
	// so a slow answer to an old query can never replace a newer one.
	$effect(() => {
		const needle = query.trim();
		if (needle === '') {
			results = undefined;
			loading = false;
			failed = false;
			return;
		}
		loading = true;
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const response = await fetch(`/search?q=${encodeURIComponent(needle)}`, {
					signal: controller.signal
				});
				if (!response.ok) throw new Error(`search failed with ${response.status}`);
				results = await response.json();
				failed = false;
				activeIndex = 0;
			} catch (error) {
				// An aborted request means a newer query took over; anything else is a real failure.
				if (controller.signal.aborted) return;
				console.error(error);
				failed = true;
			}
			loading = false;
		}, SEARCH_DELAY_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	// Then the matches by meaning, which need the model service and so arrive later than the
	// name matches. When the service is down the endpoint answers with nothing and the section
	// simply never shows.
	$effect(() => {
		const needle = query.trim();
		if (needle === '') {
			meaning = undefined;
			meaningLoading = false;
			return;
		}
		meaningLoading = true;
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const response = await fetch(`/search?by=meaning&q=${encodeURIComponent(needle)}`, {
					signal: controller.signal
				});
				if (!response.ok) throw new Error(`search by meaning failed with ${response.status}`);
				meaning = await response.json();
			} catch (error) {
				// An aborted request means a newer query took over; anything else is a real failure,
				// but the name matches are still useful, so only the meaning section goes away.
				if (controller.signal.aborted) return;
				console.error(error);
				meaning = undefined;
			}
			meaningLoading = false;
		}, MEANING_DELAY_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	// Keep the highlighted row visible while arrowing through a long list.
	$effect(() => {
		if (open)
			document.getElementById(`palette-item-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
	});

	function close() {
		open = false;
		query = '';
		activeIndex = 0;
	}

	function onWindowKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement;
		const typing = target.matches('input, textarea, select, [contenteditable]');
		if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			if (open) close();
			else open = true;
		} else if (event.key === '/' && !typing && !open && !event.metaKey && !event.ctrlKey) {
			// "/" opens the search, like most documentation and gallery sites.
			event.preventDefault();
			open = true;
		}
	}

	function onInputKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (hrefs.length === 0) return;
			const step = event.key === 'ArrowDown' ? 1 : -1;
			activeIndex = (activeIndex + step + hrefs.length) % hrefs.length;
		} else if (event.key === 'Enter' && hrefs[activeIndex] !== undefined) {
			event.preventDefault();
			const href = hrefs[activeIndex];
			close();
			goto(href);
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
	<Modal
		label="Search"
		onclose={close}
		align="top"
		class="flex max-h-[min(34rem,78dvh)] w-[min(100%,41rem)] flex-col overflow-hidden rounded-[28px] bg-neutral-800 text-white shadow-2xl ring-1 ring-white/10"
	>
		<div class="flex shrink-0 items-center gap-3 px-6 pt-5 pb-4">
			<Search class="size-5 shrink-0 text-neutral-400" strokeWidth={2.25} />
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:value={query}
				onkeydown={onInputKeydown}
				type="text"
				autofocus
				autocomplete="off"
				spellcheck="false"
				role="combobox"
				aria-expanded="true"
				aria-controls="palette-list"
				aria-activedescendant={hrefs.length > 0 ? `palette-item-${activeIndex}` : undefined}
				aria-label="Search sites, screens and elements"
				placeholder="Search Refs…"
				class="min-w-0 flex-1 border-0 bg-transparent p-0 text-[18px] text-white placeholder:text-neutral-400 focus:ring-0 focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
			/>
			{#if loading || meaningLoading}
				<LoaderCircle class="size-5 shrink-0 animate-spin text-neutral-400" strokeWidth={2.25} />
			{/if}
			<kbd
				class="hidden shrink-0 rounded-md border border-white/15 px-1.5 py-0.5 font-sans text-xs font-medium text-neutral-400 sm:block"
			>
				esc
			</kbd>
		</div>

		<div
			id="palette-list"
			role="listbox"
			aria-label="Results"
			class={[
				'min-h-0 flex-1 overflow-y-auto px-3 pb-3 transition-opacity',
				loading && results && 'opacity-60'
			]}
		>
			{#if !searching}
				{#if recents.length > 0}
					<h2 class="px-3 pt-2 pb-1.5 text-[13px] font-medium text-neutral-400">Recently viewed</h2>
					{#each recents as site, index (site.slug)}
						{@render siteRow(site, index)}
					{/each}
				{:else}
					<p class="px-3 pt-4 pb-8 text-[15px] text-neutral-400">
						Find a site by name, a screen by its title or path, or a UI element by what it is
						called. Sites you open show up here.
					</p>
				{/if}
			{:else if failed}
				<p class="px-3 pt-4 pb-8 text-[15px] text-neutral-400">
					Search is not available right now. Try again in a moment.
				</p>
			{:else if results && hrefs.length === 0 && !meaningLoading}
				<div class="flex flex-col items-center px-6 pt-8 pb-10 text-center">
					<SearchX class="size-8 text-neutral-500" strokeWidth={1.75} />
					<h2 class="mt-4 text-[17px] font-medium">No results for “{query.trim()}”</h2>
					<p class="mt-1.5 max-w-xs text-[15px] text-neutral-400">
						Check the spelling, or try a shorter word like “pricing” or “button”.
					</p>
				</div>
			{:else if results}
				{#if results.sites.length > 0}
					<h2 class="px-3 pt-2 pb-1.5 text-[13px] font-medium text-neutral-400">Sites</h2>
					{#each results.sites as site, index (site.id)}
						{@render siteRow(site, index)}
					{/each}
				{/if}
				{#if results.screens.length > 0}
					<h2 class="px-3 pt-4 pb-1.5 text-[13px] font-medium text-neutral-400">Screens</h2>
					{#each results.screens as screen, index (screen.id)}
						{@render screenRow(screen, screenOffset + index)}
					{/each}
				{/if}
				{#if results.elements.length > 0}
					<h2 class="px-3 pt-4 pb-1.5 text-[13px] font-medium text-neutral-400">Elements</h2>
					{#each results.elements as element, index (element.id)}
						{@render elementRow(
							{
								media: element.media,
								rect: element.rect,
								title: element.name || `Unnamed ${element.kind}`,
								subtitle: `${humanise(element.kind)} · ${element.siteName}`
							},
							elementOffset + index
						)}
					{/each}
				{/if}
				{#if meaning && meaning.screens.length > 0}
					<h2 class="px-3 pt-4 pb-1.5 text-[13px] font-medium text-neutral-400">
						Screens by meaning
					</h2>
					{#each meaning.screens as screen, index (screen.id)}
						{@render screenRow(screen, meaningScreenOffset + index)}
					{/each}
				{/if}
				{#if meaning && meaning.sections.length > 0}
					<h2 class="px-3 pt-4 pb-1.5 text-[13px] font-medium text-neutral-400">
						Sections by meaning
					</h2>
					{#each meaning.sections as section, index (section.id)}
						{@render elementRow(
							{
								media: section.media,
								rect: section.rect,
								title:
									section.name || (section.label ? humanise(section.label) : 'Unnamed section'),
								subtitle: `${section.label ? humanise(section.label) : 'Section'} · ${section.siteName} · ${section.screenPath}`
							},
							meaningSectionOffset + index
						)}
					{/each}
				{/if}
				{#if hrefs.length === 0 && meaningLoading}
					<p class="px-3 pt-4 pb-8 text-[15px] text-neutral-400">Looking for matches by meaning…</p>
				{/if}
			{/if}
		</div>

		<footer
			class="hidden shrink-0 items-center gap-5 border-t border-white/10 px-6 py-3 text-[13px] text-neutral-400 sm:flex"
		>
			<span><kbd class="font-sans">↑↓</kbd> to move</span>
			<span><kbd class="font-sans">↵</kbd> to open</span>
			<span><kbd class="font-sans">esc</kbd> to close</span>
		</footer>
	</Modal>
{/if}

<!-- A site row; recently viewed sites and site results look the same. -->
{#snippet siteRow(site: RecentSite, itemIndex: number)}
	<a
		id="palette-item-{itemIndex}"
		role="option"
		aria-selected={activeIndex === itemIndex}
		href="/sites/{site.slug}"
		onclick={close}
		onmousemove={() => (activeIndex = itemIndex)}
		class={[
			'flex items-center gap-3.5 rounded-2xl px-3 py-2.5 outline-none',
			activeIndex === itemIndex && 'bg-white/10'
		]}
	>
		<span class="flex w-[60px] shrink-0 justify-center">
			<SiteIcon name={site.name} icon={site.icon} class="size-11 rounded-xl" />
		</span>
		<span class="min-w-0 flex-1 leading-snug">
			<span class="block truncate text-[16px] font-medium">{site.name}</span>
			<span class="block truncate text-[14px] text-neutral-400">{site.host}</span>
		</span>
		<span class="shrink-0 text-[13px] text-neutral-500">Site</span>
		{@render enterHint(itemIndex)}
	</a>
{/snippet}

<!-- A screen row; name matches and matches by meaning look the same. -->
{#snippet screenRow(screen: SemanticScreenHit, itemIndex: number)}
	<a
		id="palette-item-{itemIndex}"
		role="option"
		aria-selected={activeIndex === itemIndex}
		href={hrefs[itemIndex]}
		onclick={close}
		onmousemove={() => (activeIndex = itemIndex)}
		class={[
			'flex items-center gap-3.5 rounded-2xl px-3 py-2.5 outline-none',
			activeIndex === itemIndex && 'bg-white/10'
		]}
	>
		<span class="flex h-11 w-[60px] shrink-0 justify-center">
			<img
				src="/media/{screen.thumb}"
				alt=""
				width={screen.width}
				height={screen.height}
				loading="lazy"
				class={[
					'h-full rounded-md bg-white object-cover object-top',
					screen.viewport === 'mobile' ? 'w-8' : 'w-full'
				]}
			/>
		</span>
		<span class="min-w-0 flex-1 leading-snug">
			<span class="block truncate text-[16px] font-medium">{screen.title || screen.path}</span>
			<span class="block truncate text-[14px] text-neutral-400">
				{screen.siteName} · {screen.pageType ? `${humanise(screen.pageType)} · ` : ''}{screen.path}
			</span>
		</span>
		<span class="shrink-0 text-[13px] text-neutral-500 capitalize">{screen.viewport}</span>
		{@render enterHint(itemIndex)}
	</a>
{/snippet}

<!-- An element or section row. -->
{#snippet elementRow(
	element: { media: string; rect: Rect; title: string; subtitle: string },
	itemIndex: number
)}
	<a
		id="palette-item-{itemIndex}"
		role="option"
		aria-selected={activeIndex === itemIndex}
		href={hrefs[itemIndex]}
		onclick={close}
		onmousemove={() => (activeIndex = itemIndex)}
		class={[
			'flex items-center gap-3.5 rounded-2xl px-3 py-2.5 outline-none',
			activeIndex === itemIndex && 'bg-white/10'
		]}
	>
		<!-- A light stage keeps dark crops readable on the dark panel. -->
		<span
			class="flex h-11 w-[60px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100 p-1.5"
		>
			<img
				src="/media/{element.media}"
				alt=""
				loading="lazy"
				class="max-h-full max-w-full object-contain"
				style:width="{element.rect.w}px"
			/>
		</span>
		<span class="min-w-0 flex-1 leading-snug">
			<span class="block truncate text-[16px] font-medium">{element.title}</span>
			<span class="block truncate text-[14px] text-neutral-400">{element.subtitle}</span>
		</span>
		{@render enterHint(itemIndex)}
	</a>
{/snippet}

{#snippet enterHint(itemIndex: number)}
	<CornerDownLeft
		class={[
			'hidden size-4 shrink-0 text-neutral-400 sm:block',
			activeIndex !== itemIndex && 'invisible'
		]}
		strokeWidth={2}
	/>
{/snippet}
