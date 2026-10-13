<script lang="ts">
	import { onMount, type Snippet } from 'svelte';

	type Props = {
		label: string;
		/** Called for Escape and clicks on the backdrop. The parent decides how to close. */
		onclose: () => void;
		/** Classes for the panel, which decides the modal's size and colour. */
		class?: string;
		children: Snippet;
	};

	let { label, onclose, class: className, children }: Props = $props();

	let dialog = $state<HTMLDialogElement>();

	// A native modal <dialog> brings focus trapping, an inert page behind it, Escape handling,
	// focus restoration and the top layer. It is only rendered while open, so open it right away.
	onMount(() => dialog?.showModal());
</script>

<!-- The dialog fills the viewport and is see-through, so a click that lands on it directly is a
backdrop click. Keyboard users close with Escape. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={dialog}
	aria-label={label}
	oncancel={(event) => {
		// Keep the dialog open until the parent unmounts it; Escape should go through onclose.
		event.preventDefault();
		onclose();
	}}
	onmousedown={(event) => {
		if (event.target === dialog) onclose();
	}}
	class="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none bg-transparent p-0 backdrop:bg-black/50 open:flex open:items-center open:justify-center"
>
	<div class={['relative animate-pop-in', className]}>
		{@render children()}
	</div>
</dialog>
