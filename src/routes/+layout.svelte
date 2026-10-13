<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import TopBar from '#lib/components/TopBar.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Refs: design reference library</title>
</svelte:head>

<TopBar />
<main class="mx-auto max-w-[1920px] px-6 pb-24 sm:px-8 lg:px-10">
	{@render children()}
</main>
