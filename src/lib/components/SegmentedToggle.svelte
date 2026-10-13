<script lang="ts" generics="Value extends string">
	// A pill-shaped switch like Mobbin's iOS/Web toggle. Options are real links so the toggle
	// works without JS and each state is addressable in the URL.
	type Option = { value: Value; label: string; href: string };

	let { options, active, label }: { options: Option[]; active: Value; label: string } = $props();
</script>

<div
	class="inline-flex rounded-full bg-neutral-100 p-1 dark:bg-white/[0.07]"
	role="group"
	aria-label={label}
	data-sveltekit-reset="false"
>
	{#each options as option (option.value)}
		<a
			href={option.href}
			aria-current={option.value === active ? 'true' : undefined}
			class={[
				'rounded-full px-4 py-1.5 text-[15px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-black dark:focus-visible:outline-white',
				option.value === active &&
					'bg-white text-black shadow-[0_1px_2px_rgb(0_0_0/0.12)] dark:bg-white/[0.16] dark:text-white dark:shadow-none',
				option.value !== active &&
					'text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-white'
			]}
		>
			{option.label}
		</a>
	{/each}
</div>
