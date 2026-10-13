<script lang="ts">
	import type { Screen } from '../types.ts';

	let { screen, href }: { screen: Screen; href: string } = $props();
</script>

<a
	{href}
	class="group flex flex-col gap-3 rounded-[28px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black dark:focus-visible:outline-white"
>
	{#if screen.viewport === 'mobile'}
		<!-- Phone cards: the screenshot is the card, like Mobbin's app screens. -->
		<div
			class="relative overflow-hidden rounded-[26px] bg-neutral-100 ring-1 ring-black/[0.06] transition-shadow group-hover:ring-black/20 dark:bg-white/[0.07] dark:ring-white/10 dark:group-hover:ring-white/30"
			style:aspect-ratio="{screen.width} / {screen.height}"
		>
			<img
				src="/media/{screen.media.thumb}"
				width={screen.width}
				height={screen.height}
				alt={screen.title || screen.path}
				loading="lazy"
				class="size-full object-cover"
			/>
			{@render badge()}
		</div>
	{:else}
		<div
			class="relative flex aspect-[1.4] items-center justify-center overflow-hidden rounded-3xl bg-neutral-100 transition-colors group-hover:bg-neutral-200/70 dark:bg-white/[0.07] dark:group-hover:bg-white/[0.11]"
		>
			<img
				src="/media/{screen.media.thumb}"
				width={screen.width}
				height={screen.height}
				alt={screen.title || screen.path}
				loading="lazy"
				class="w-[86%] rounded-xl bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.25)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.12)]"
				style:aspect-ratio="{screen.width} / {screen.height}"
			/>
			{@render badge()}
		</div>
	{/if}

	<div class="min-w-0 px-0.5 leading-snug">
		<div class="truncate text-[15px] font-medium">{screen.path}</div>
		<div class="truncate text-[14px] text-neutral-500 dark:text-neutral-400">
			{screen.title || 'Untitled'}
		</div>
	</div>
</a>

{#snippet badge()}
	{#if screen.kind === 'state'}
		<span
			class="absolute top-3 left-3 rounded-lg bg-neutral-500/70 px-2.5 py-1 text-[13px] font-medium text-white backdrop-blur"
		>
			State
		</span>
	{/if}
{/snippet}
