<script lang="ts">
	import {
		Check,
		ChevronLeft,
		ChevronRight,
		Copy,
		Download,
		ExternalLink,
		X
	} from '@lucide/svelte';
	import type { ScreenDetail } from '#lib/server/queries.ts';
	import type { Site } from '../types.ts';
	import Modal from './Modal.svelte';
	import SiteIcon from './SiteIcon.svelte';

	type Props = {
		detail: ScreenDetail;
		site: Site;
		/** Element to highlight when the viewer opens, from the `?el=` param. */
		initialElementId?: string;
		/** Link target for a screen in the viewer (keeps the page's other params). */
		screenHref: (screenId: string) => string;
		onclose: () => void;
		/** Moves to another screen; replaces the history entry so Back still closes the viewer. */
		onnavigate: (screenId: string) => void;
	};

	let { detail, site, initialElementId, screenHref, onclose, onnavigate }: Props = $props();

	const screen = $derived(detail.screen);

	let mode = $state<'full' | 'viewport'>('full');
	let hoveredId = $state<string | undefined>(undefined);
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
	let scroller: HTMLDivElement | undefined = $state();
	let imageBox: HTMLDivElement | undefined = $state();

	// An element picked by hand belongs to the screen it was picked on. On any other screen the
	// selection falls back to the `?el=` element from the URL.
	let manualSelection = $state<{ screenId: string; elementId: string | undefined }>();
	const selectedId = $derived(
		manualSelection?.screenId === screen.id ? manualSelection.elementId : initialElementId
	);

	const imageKey = $derived(mode === 'full' ? screen.media.full : screen.media.viewport);
	// Heights are CSS px; the full-page image is `full_height` tall, the viewport one `height`.
	const imageHeight = $derived(mode === 'full' ? screen.full_height : screen.height);
	const highlighted = $derived(
		detail.elements.find((element) => element.id === (hoveredId ?? selectedId))
	);

	// Scroll the selected element into view. Rects are CSS px in page coordinates, so the
	// position inside the rendered image is a plain ratio of its height.
	$effect(() => {
		const element = detail.elements.find((candidate) => candidate.id === selectedId);
		if (!element || !scroller || !imageBox) return;
		const top = imageBox.offsetTop + (element.rect.y / imageHeight) * imageBox.offsetHeight;
		scroller.scrollTo({ top: Math.max(0, top - 96), behavior: 'smooth' });
	});

	function onkeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement;
		if (target.matches('input, textarea, select') || event.metaKey || event.ctrlKey || event.altKey)
			return;
		if (event.key === 'ArrowLeft' && detail.prevId) onnavigate(detail.prevId);
		if (event.key === 'ArrowRight' && detail.nextId) onnavigate(detail.nextId);
	}

	/**
	 * Copies the shown image as PNG. Browsers only accept PNG on the clipboard while the crawler
	 * stores webp, so the pixels take a detour through a canvas.
	 */
	async function copy() {
		async function toPng(): Promise<Blob> {
			const response = await fetch(`/media/${imageKey}`);
			if (!response.ok) throw new Error('could not load the image');
			const bitmap = await createImageBitmap(await response.blob());
			const canvas = document.createElement('canvas');
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
			bitmap.close();
			return new Promise((resolve, reject) =>
				canvas.toBlob(
					(blob) => (blob ? resolve(blob) : reject(new Error('png encoding failed'))),
					'image/png'
				)
			);
		}

		try {
			// Handing over the promise (not the blob) keeps Safari happy: it wants the clipboard
			// write to start synchronously inside the click handler.
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPng() })]);
			copyState = 'copied';
		} catch {
			copyState = 'failed';
		}
		setTimeout(() => (copyState = 'idle'), 2000);
	}

	function percent(value: number, total: number): string {
		return `${(value / total) * 100}%`;
	}
</script>

<svelte:window {onkeydown} />

<Modal
	label="Screen viewer"
	{onclose}
	class="flex h-[calc(100vh-48px)] w-[calc(100vw-48px)] max-w-[1840px] flex-col overflow-hidden rounded-[28px] bg-white shadow-2xl"
>
	<header class="flex h-[76px] shrink-0 items-center gap-6 px-6">
		<div class="flex min-w-0 flex-1 items-center gap-3">
			<SiteIcon name={site.name} icon={site.icon} class="size-10 rounded-xl" />
			<div class="min-w-0 leading-snug">
				<h2 class="truncate text-[17px] font-semibold tracking-tight">
					{screen.title || screen.path}
				</h2>
				<div class="truncate text-[14px] text-neutral-500">{site.name} · {screen.path}</div>
			</div>
		</div>

		<div class="inline-flex rounded-full bg-neutral-100 p-1" role="group" aria-label="Image">
			{#each [['full', 'Full page'], ['viewport', 'Viewport']] as const as [value, label] (value)}
				<button
					type="button"
					aria-pressed={mode === value}
					onclick={() => (mode = value)}
					class={[
						'rounded-full px-4 py-1.5 text-[15px] font-medium transition-colors',
						mode === value && 'bg-white shadow-[0_1px_2px_rgb(0_0_0/0.12)]',
						mode !== value && 'text-neutral-500 hover:text-black'
					]}
				>
					{label}
				</button>
			{/each}
		</div>

		<div class="flex flex-1 items-center justify-end gap-2">
			<button
				type="button"
				onclick={copy}
				class="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-neutral-200 bg-white px-5 text-[15px] font-medium whitespace-nowrap transition-colors hover:bg-neutral-100"
			>
				{#if copyState === 'copied'}
					<Check class="-ml-1 size-4" strokeWidth={2.5} /> Copied
				{:else if copyState === 'failed'}
					Copy failed
				{:else}
					<Copy class="-ml-1 size-4" strokeWidth={2} /> Copy image
				{/if}
			</button>
			<a
				href="/media/{imageKey}"
				download="{site.slug}-{screen.id}-{mode}.webp"
				class="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-neutral-200 bg-white px-5 text-[15px] font-medium whitespace-nowrap transition-colors hover:bg-neutral-100"
			>
				<Download class="-ml-1 size-4" strokeWidth={2} /> Download
			</a>
			<button
				type="button"
				aria-label="Close"
				onclick={onclose}
				class="ml-1 flex size-10 items-center justify-center rounded-full bg-neutral-100 transition-colors hover:bg-neutral-200"
			>
				<X class="size-[18px]" strokeWidth={2.25} />
			</button>
		</div>
	</header>

	<div class="flex min-h-0 flex-1 flex-col lg:flex-row">
		<div class="relative min-h-0 flex-1">
			<!-- Focusable and autofocused so the arrow-up/down keys scroll the image right away. -->
			<!-- svelte-ignore a11y_autofocus, a11y_no_noninteractive_tabindex -->
			<div
				bind:this={scroller}
				tabindex="0"
				autofocus
				class="absolute inset-x-3 inset-y-0 overflow-y-auto rounded-t-3xl bg-neutral-100 px-6 pt-8 pb-12 outline-none lg:right-0"
			>
				<!-- Natural CSS width caps the image so a 390px phone page is not blown up. -->
				<div
					bind:this={imageBox}
					class="relative mx-auto w-full overflow-hidden bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_12px_32px_-16px_rgb(0_0_0/0.3)]"
					style:max-width="{screen.width}px"
					style:aspect-ratio="{screen.width} / {imageHeight}"
					style:border-radius={screen.viewport === 'mobile' ? '28px' : '14px'}
				>
					{#key imageKey}
						<img
							src="/media/{imageKey}"
							width={screen.width}
							height={imageHeight}
							alt="Screenshot of {screen.path}"
							class="block size-full"
						/>
					{/key}
					{#if highlighted}
						<!-- The huge spread shadow dims everything except the highlighted element. -->
						<div
							class="pointer-events-none absolute rounded-sm shadow-[0_0_0_9999px_rgb(0_0_0/0.35)] outline-2 outline-blue-500"
							style:left={percent(highlighted.rect.x, screen.width)}
							style:top={percent(highlighted.rect.y, imageHeight)}
							style:width={percent(highlighted.rect.w, screen.width)}
							style:height={percent(highlighted.rect.h, imageHeight)}
						></div>
					{/if}
				</div>
			</div>

			{#if detail.prevId}
				<a
					href={screenHref(detail.prevId)}
					aria-label="Previous screen"
					data-sveltekit-replacestate
					data-sveltekit-reset="false"
					class="absolute top-1/2 left-6 flex size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-[0_2px_12px_rgb(0_0_0/0.18)] transition-transform hover:scale-105"
				>
					<ChevronLeft class="size-6" strokeWidth={2} />
				</a>
			{/if}
			{#if detail.nextId}
				<a
					href={screenHref(detail.nextId)}
					aria-label="Next screen"
					data-sveltekit-replacestate
					data-sveltekit-reset="false"
					class="absolute top-1/2 right-6 flex size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-[0_2px_12px_rgb(0_0_0/0.18)] transition-transform hover:scale-105"
				>
					<ChevronRight class="size-6" strokeWidth={2} />
				</a>
			{/if}
		</div>

		<aside class="max-h-[40%] shrink-0 overflow-y-auto px-6 pt-6 pb-8 lg:max-h-none lg:w-[380px]">
			<dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-[15px]">
				<dt class="text-neutral-500">Page</dt>
				<dd class="min-w-0">
					<a
						href={screen.url}
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex max-w-full items-center gap-1.5 font-medium underline-offset-4 hover:underline"
					>
						<span class="truncate">{screen.path}</span>
						<ExternalLink class="size-3.5 shrink-0" strokeWidth={2} />
					</a>
				</dd>
				<dt class="text-neutral-500">Viewport</dt>
				<dd class="font-medium">
					<span class="capitalize">{screen.viewport}</span> ({screen.width}×{screen.height})
				</dd>
				<dt class="text-neutral-500">Full page</dt>
				<dd class="font-medium">{screen.width}×{screen.full_height}</dd>
				<dt class="text-neutral-500">Type</dt>
				<dd class="font-medium">{screen.kind === 'state' ? 'State' : 'Page'}</dd>
				<dt class="text-neutral-500">Captured</dt>
				<dd class="font-medium">
					{new Date(screen.captured_at).toLocaleDateString('en', {
						dateStyle: 'medium',
						timeZone: 'UTC'
					})}
				</dd>
				<dt class="text-neutral-500">Reached by</dt>
				<dd class="flex flex-col gap-1.5 font-medium">
					{#each detail.reachedBy as via, index (index)}
						<span>
							{#if via.kind === 'click'}
								Clicked “{via.label || 'element'}” on
							{:else if via.label}
								Link “{via.label}” from
							{:else}
								Link from
							{/if}
							<a
								href={screenHref(via.fromId)}
								data-sveltekit-replacestate
								data-sveltekit-reset="false"
								class="underline underline-offset-4 hover:text-neutral-600"
							>
								{via.fromPath}
							</a>
						</span>
					{:else}
						<span class="font-normal text-neutral-500">
							{screen.depth === 0 ? 'Start page' : 'Unknown'}
						</span>
					{/each}
				</dd>
			</dl>

			<div class="mt-8 flex items-baseline justify-between">
				<h3 class="text-[17px] font-semibold tracking-tight">Elements</h3>
				<span class="text-[14px] text-neutral-500">{detail.elements.length} on this screen</span>
			</div>
			{#if detail.elements.length > 0}
				<ul class="mt-3 grid grid-cols-2 gap-2.5">
					{#each detail.elements as element (element.id)}
						<li>
							<button
								type="button"
								aria-pressed={selectedId === element.id}
								onmouseenter={() => (hoveredId = element.id)}
								onmouseleave={() => (hoveredId = undefined)}
								onfocus={() => (hoveredId = element.id)}
								onblur={() => (hoveredId = undefined)}
								onclick={() =>
									(manualSelection = {
										screenId: screen.id,
										elementId: selectedId === element.id ? undefined : element.id
									})}
								class={[
									'flex w-full flex-col gap-1.5 rounded-2xl bg-neutral-100 p-2 text-left transition-shadow',
									selectedId === element.id && 'ring-2 ring-black',
									selectedId !== element.id && 'hover:ring-1 hover:ring-black/30'
								]}
							>
								<span class="flex h-24 items-center justify-center overflow-hidden rounded-xl">
									<img
										src="/media/{element.media}"
										alt=""
										loading="lazy"
										class="max-h-full max-w-full object-contain"
									/>
								</span>
								<span class="truncate px-1 text-[13px] leading-tight">
									<span class="font-medium capitalize">{element.kind}</span>
									{#if element.name}<span class="text-neutral-500"> · {element.name}</span>{/if}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="mt-3 text-[15px] text-neutral-500">No elements were cropped from this screen.</p>
			{/if}

			<p class="mt-8 text-[13px] text-neutral-400">
				{detail.position} of {detail.total} · use ← → to browse, Esc to close
			</p>
		</aside>
	</div>
</Modal>
