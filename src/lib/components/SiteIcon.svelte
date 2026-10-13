<script lang="ts">
	// The favicon tile, or the first letter of the name on a tint when the site has no icon yet.
	// The size comes from the caller's classes, e.g. class="size-10 rounded-xl".
	type Props = { name: string; icon?: string; class?: string };
	let { name, icon, class: className }: Props = $props();

	// A hash of the name picks the hue, so a given site always gets the same colour.
	const hue = $derived(
		[...name].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 7) % 360
	);
</script>

{#if icon}
	<img
		src="/media/{icon}"
		alt=""
		class={['shrink-0 bg-neutral-100 object-cover ring-1 ring-black/5', className]}
	/>
{:else}
	<!-- An SVG letter scales with whatever size the caller picked. -->
	<svg
		viewBox="0 0 100 100"
		aria-hidden="true"
		class={['shrink-0 overflow-hidden', className]}
		style:background-color="hsl({hue} 62% 46%)"
	>
		<text x="50" y="68" font-size="52" font-weight="600" fill="white" text-anchor="middle">
			{name.charAt(0).toUpperCase()}
		</text>
	</svg>
{/if}
