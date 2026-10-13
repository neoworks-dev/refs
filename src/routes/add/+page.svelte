<script lang="ts">
	import AddSiteForm from '#lib/components/AddSiteForm.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head><title>Add site · Refs</title></svelte:head>

<!-- Standalone version of the dialog: what the link opens without JS or in a new tab. -->
<div
	class="mx-auto mt-8 w-full max-w-lg rounded-[2rem] bg-neutral-50 px-6 py-10 sm:mt-24 sm:px-10 sm:py-12 dark:bg-white/5"
>
	<AddSiteForm initial={form ?? undefined} />
</div>
