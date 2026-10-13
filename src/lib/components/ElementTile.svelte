<script lang="ts">
	import type { ElementListItem } from '#lib/server/queries.ts';
	import { humanise } from '../labels.ts';
	import SaveButton from './SaveButton.svelte';
	import SiteIcon from './SiteIcon.svelte';

	type Props = {
		element: ElementListItem;
		href: string;
		/** Names the site under the crop, for lists that mix sites. */
		site?: { name: string; icon?: string };
	};

	let { element, href, site }: Props = $props();

	// Crops come in very different shapes, so the tile picks one of four presentations. All of
	// them sit on the same fixed-height gray stage to keep the grid calm, and none is ever shown
	// larger than its natural CSS size.
	// - small: a button, input or menu item, centred.
	// - wide: a header or nav strip. A strip this thin is unreadable at column width, so the
	//   tile spans two columns and the strip fills it.
	// - tall: a sidebar or a phone-height section. Fitting it to the tile would leave a sliver,
	//   so it shows the top and is cropped at the bottom edge.
	// - fit: everything else, scaled down to fit whole.
	const WIDE_ASPECT = 6;
	// Narrower strips, like a phone header, are already readable in a single column.
	const WIDE_MIN_WIDTH = 600;
	const TALL_ASPECT = 0.75;
	// Larger than this and a crop is a block rather than a control, so it gets an outline.
	const SMALL_MAX_WIDTH = 360;
	const SMALL_MAX_HEIGHT = 160;

	const aspect = $derived(element.rect.w / element.rect.h);
	const shape = $derived(
		aspect >= WIDE_ASPECT && element.rect.w >= WIDE_MIN_WIDTH
			? 'wide'
			: aspect <= TALL_ASPECT
				? 'tall'
				: element.rect.w <= SMALL_MAX_WIDTH && element.rect.h <= SMALL_MAX_HEIGHT
					? 'small'
					: 'fit'
	);
	// A labelled section reads better as its label ("Hero") than as the kind it shares with all.
	const kindLabel = $derived(humanise(element.label ?? element.kind));
	const title = $derived(element.name || kindLabel);
	// An unnamed element already shows its kind as the title. Next to the site's own icon the page
	// path matters less than the site's name.
	const subtitle = $derived.by(() => {
		if (site) return element.name ? `${site.name} · ${kindLabel}` : site.name;
		return element.name ? `${kindLabel} · ${element.screen_path}` : element.screen_path;
	});
</script>

<!-- The tile is the grid item itself, because a wide tile has to span two columns. -->
<li class={['group/card relative', shape === 'wide' && 'sm:col-span-2']}>
	<a
		{href}
		class="group flex flex-col gap-2.5 rounded-3xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black dark:focus-visible:outline-white"
	>
		<div
			class={[
				'relative flex h-56 justify-center overflow-hidden rounded-3xl bg-neutral-100 transition-colors group-hover:bg-neutral-200/70 sm:h-60 dark:bg-white/[0.07] dark:group-hover:bg-white/[0.11]',
				shape === 'tall' ? 'items-start px-5 pt-5' : 'items-center p-5'
			]}
		>
			<!-- The attributes keep the aspect ratio before the image loads. Width and height are
		then set to auto, because the stored crop is twice its CSS size (device scale 2). -->
			<img
				src="/media/{element.media}"
				alt={title}
				loading="lazy"
				width={Math.round(element.rect.w)}
				height={Math.round(element.rect.h)}
				class={[
					'h-auto max-w-full',
					(shape === 'wide' || shape === 'tall') && 'w-full',
					(shape === 'small' || shape === 'fit') && 'max-h-full w-auto object-contain',
					shape !== 'small' &&
						'bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.06)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1)]',
					shape === 'tall' ? 'rounded-t-lg' : shape !== 'small' && 'rounded-lg'
				]}
				style:max-width={shape === 'small' || shape === 'fit'
					? `min(100%, ${element.rect.w}px)`
					: `${element.rect.w}px`}
			/>
		</div>
		<div class="flex min-w-0 items-center gap-2.5 px-1">
			{#if site}
				<SiteIcon name={site.name} icon={site.icon} class="size-9 rounded-[10px]" />
			{/if}
			<div class="min-w-0 leading-snug">
				<div class="truncate text-[15px] font-medium">{title}</div>
				<div class="truncate text-[14px] text-neutral-500 dark:text-neutral-400">
					{subtitle}
				</div>
			</div>
		</div>
	</a>
	<!-- A sibling of the link, because a button cannot sit inside a link. -->
	<SaveButton table="element" id={element.id} label={title} variant="overlay" />
</li>
