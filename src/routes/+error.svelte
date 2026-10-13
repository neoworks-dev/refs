<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head><title>{page.status} · Refs</title></svelte:head>

<div class="flex flex-col items-center px-2 pt-24 text-center sm:pt-32">
	<p class="text-[15px] font-medium text-neutral-400">{page.status}</p>
	<h1 class="mt-3 text-[32px] font-semibold tracking-[-0.045em] sm:text-[40px]">
		{page.status === 404 ? 'Nothing here' : 'Something went wrong'}
	</h1>
	<p class="mt-3 max-w-sm text-[17px] text-neutral-500">
		{page.status === 404
			? 'This page or site does not exist, or it was removed.'
			: page.error?.message}
	</p>
	<a
		href="/"
		class="mt-8 inline-flex h-11 items-center justify-center rounded-full bg-black px-5 text-[15px] font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
	>
		Back to sites
	</a>
</div>
