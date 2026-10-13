<script lang="ts">
	import './layout.css';
	import { navigating } from '$app/state';
	import favicon from '#lib/assets/favicon.svg';
	import TopBar from '#lib/components/TopBar.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Refs: design reference library</title>
</svelte:head>

<!-- A thin bar under the top edge shows that a navigation is loading. It waits a moment before
appearing so quick navigations do not flash it. -->
{#if navigating.to}
	<div
		class="fixed inset-x-0 top-0 z-50 h-0.5 animate-fade-in overflow-hidden [animation-delay:200ms] [animation-fill-mode:backwards]"
		role="progressbar"
		aria-label="Loading"
	>
		<div class="h-full w-1/3 animate-progress bg-black dark:bg-white"></div>
	</div>
{/if}

<TopBar />
<main class="mx-auto max-w-[1920px] px-6 pb-24 sm:px-8 lg:px-10">
	{@render children()}
</main>
