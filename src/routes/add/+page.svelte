<script lang="ts">
	import AddSiteForm from '#lib/components/AddSiteForm.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head><title>Add site · Refs</title></svelte:head>

<!-- Standalone version of the dialog: what the link opens without JS or in a new tab. -->
<div class="mx-auto mt-16 w-full max-w-lg rounded-[2rem] bg-neutral-50 px-10 py-12 sm:mt-24">
	<AddSiteForm initial={form ?? undefined} />
</div>
