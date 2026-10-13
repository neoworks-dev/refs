<script lang="ts">
	import type { UiElement } from '../types.ts';

	let { element, href }: { element: UiElement; href: string } = $props();

	// Small controls get a gray stage and stay at natural (CSS px) size; big blocks such as
	// sections fill the column. The width/height attributes reserve space so nothing shifts on load.
	const isControl = $derived(element.kind === 'button' || element.kind === 'input');
</script>

<a
	{href}
	class="group flex flex-col gap-2.5 rounded-3xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black"
>
	{#if isControl}
		<div
			class="flex min-h-36 items-center justify-center rounded-3xl bg-neutral-100 p-8 transition-colors group-hover:bg-neutral-200/70"
		>
			<img
				src="/media/{element.media}"
				alt={element.name || element.kind}
				loading="lazy"
				width={Math.round(element.rect.w)}
				height={Math.round(element.rect.h)}
				class="h-auto max-w-full"
				style:width="{element.rect.w}px"
			/>
		</div>
	{:else}
		<div
			class="overflow-hidden rounded-2xl bg-neutral-100 ring-1 ring-black/[0.06] transition-shadow group-hover:ring-black/25"
		>
			<img
				src="/media/{element.media}"
				alt={element.name || element.kind}
				loading="lazy"
				width={Math.round(element.rect.w)}
				height={Math.round(element.rect.h)}
				class="block h-auto w-full"
				style:aspect-ratio="{element.rect.w} / {element.rect.h}"
			/>
		</div>
	{/if}
	<div class="min-w-0 px-1 leading-snug">
		<div class="truncate text-[15px] font-medium">{element.name || element.kind}</div>
		<div class="truncate text-[14px] text-neutral-500 capitalize">{element.kind}</div>
	</div>
</a>
