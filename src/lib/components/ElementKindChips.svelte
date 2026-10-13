<script lang="ts">
	import type { ElementKind } from '../types.ts';

	// The filter chips above an element grid: "All" plus one chip per kind that exists, with its
	// count. Shared by a site's Elements tab and the library across sites.
	type Props = {
		counts: Partial<Record<ElementKind, number>>;
		active?: ElementKind;
		/** Link target for a kind, or for "All" when the kind is undefined. */
		href: (kind?: ElementKind) => string;
	};

	let { counts, active, href }: Props = $props();

	const kindLabels: Record<ElementKind, string> = {
		section: 'Sections',
		header: 'Headers',
		footer: 'Footers',
		nav: 'Navigation',
		button: 'Buttons',
		input: 'Inputs',
		form: 'Forms',
		dialog: 'Dialogs',
		menu: 'Menus',
		table: 'Tables'
	};

	const kinds = $derived(
		(Object.keys(kindLabels) as ElementKind[]).filter((kind) => (counts[kind] ?? 0) > 0)
	);
</script>

<div class="flex flex-wrap gap-2" data-sveltekit-reset="false">
	<a
		href={href(undefined)}
		aria-current={active === undefined ? 'true' : undefined}
		class={[
			'inline-flex h-10 items-center rounded-full border px-4 text-[15px] font-medium transition-colors',
			active === undefined &&
				'border-black bg-black text-white dark:border-white dark:bg-white dark:text-black',
			active !== undefined &&
				'border-neutral-200 hover:bg-neutral-100 dark:border-white/15 dark:hover:bg-white/10'
		]}
	>
		All
	</a>
	{#each kinds as kind (kind)}
		<a
			href={href(kind)}
			aria-current={active === kind ? 'true' : undefined}
			class={[
				'inline-flex h-10 items-center gap-2 rounded-full border px-4 text-[15px] font-medium transition-colors',
				active === kind &&
					'border-black bg-black text-white dark:border-white dark:bg-white dark:text-black',
				active !== kind &&
					'border-neutral-200 hover:bg-neutral-100 dark:border-white/15 dark:hover:bg-white/10'
			]}
		>
			{kindLabels[kind]}
			<span
				class={[
					active === kind && 'text-white/60 dark:text-black/50',
					active !== kind && 'text-neutral-400 dark:text-neutral-500'
				]}
			>
				{counts[kind]}
			</span>
		</a>
	{/each}
</div>
