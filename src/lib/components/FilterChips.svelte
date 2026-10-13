<script lang="ts">
	// A row of filter chips: "All" plus one chip per value that exists, with its count. Used for
	// element kinds, section labels and page types, so the three read as the same control.
	type Props = {
		/** Every value the filter knows, in the order the chips are shown. */
		values: readonly string[];
		counts: Partial<Record<string, number>>;
		label: (value: string) => string;
		active?: string;
		/** Link target for a value, or for "All" when the value is undefined. */
		href: (value?: string) => string;
		/** A quieter, smaller row for a filter that refines another one. */
		compact?: boolean;
		ariaLabel: string;
	};

	let { values, counts, label, active, href, compact = false, ariaLabel }: Props = $props();

	// The active value stays visible even without matches, for instance after switching to a
	// viewport that doesn't have it, so the filter can still be seen and cleared.
	const present = $derived(values.filter((value) => (counts[value] ?? 0) > 0 || value === active));
</script>

<!-- On a phone the row scrolls sideways, because a page type filter can have twenty chips and
wrapping them would push the screens below the fold. The negative margin lets it bleed to the edge. -->
<nav
	class="-mx-6 flex [scrollbar-width:none] gap-2 overflow-x-auto px-6 sm:mx-0 sm:flex-wrap sm:px-0"
	aria-label={ariaLabel}
	data-sveltekit-reset="false"
>
	<a
		href={href(undefined)}
		aria-current={active === undefined ? 'true' : undefined}
		class={[
			'inline-flex shrink-0 items-center rounded-full border font-medium transition-colors',
			compact ? 'h-8 px-3.5 text-[14px]' : 'h-10 px-4 text-[15px]',
			active === undefined &&
				'border-black bg-black text-white dark:border-white dark:bg-white dark:text-black',
			active !== undefined &&
				'border-neutral-200 hover:bg-neutral-100 dark:border-white/15 dark:hover:bg-white/10'
		]}
	>
		All
	</a>
	{#each present as value (value)}
		<a
			href={href(value)}
			aria-current={active === value ? 'true' : undefined}
			class={[
				'inline-flex shrink-0 items-center gap-2 rounded-full border font-medium transition-colors',
				compact ? 'h-8 px-3.5 text-[14px]' : 'h-10 px-4 text-[15px]',
				active === value &&
					'border-black bg-black text-white dark:border-white dark:bg-white dark:text-black',
				active !== value &&
					'border-neutral-200 hover:bg-neutral-100 dark:border-white/15 dark:hover:bg-white/10'
			]}
		>
			{label(value)}
			<span
				class={[
					active === value && 'text-white/60 dark:text-black/50',
					active !== value && 'text-neutral-400 dark:text-neutral-500'
				]}
			>
				{counts[value] ?? 0}
			</span>
		</a>
	{/each}
</nav>
