<script lang="ts">
	import { X } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import Modal from './Modal.svelte';

	type Props = {
		title: string;
		/** The form action that receives `name` and `description`. */
		action: string;
		submitLabel: string;
		/** Prefilled values when editing a collection. */
		initial?: { name: string; description?: string };
		onclose: () => void;
	};

	let { title, action, submitLabel, initial, onclose }: Props = $props();

	let message = $state<string>();
</script>

<Modal
	label={title}
	{onclose}
	class="w-[min(92vw,34rem)] rounded-[2rem] bg-white p-6 shadow-2xl sm:p-8 dark:bg-neutral-900 dark:ring-1 dark:ring-white/10"
>
	<div class="relative mb-6 flex items-center justify-center">
		<h2 class="text-[20px] font-semibold tracking-tight">{title}</h2>
		<button
			type="button"
			aria-label="Close"
			onclick={onclose}
			class="absolute right-0 flex size-9 items-center justify-center rounded-full bg-neutral-100 transition-colors hover:bg-neutral-200 dark:bg-white/10 dark:hover:bg-white/20"
		>
			<X class="size-4" strokeWidth={2.25} />
		</button>
	</div>

	<form
		method="POST"
		{action}
		class="flex flex-col gap-5"
		use:enhance={() =>
			async ({ result, update }) => {
				if (result.type === 'failure') {
					message = (result.data as { message?: string } | undefined)?.message;
					return;
				}
				await update({ reset: false });
				onclose();
			}}
	>
		<label class="flex flex-col gap-2 text-[15px] font-medium">
			Name
			<!-- svelte-ignore a11y_autofocus -->
			<input
				name="name"
				required
				autofocus
				autocomplete="off"
				value={initial?.name ?? ''}
				placeholder="For example, Pricing pages"
				class="h-12 rounded-2xl border-0 bg-neutral-100 px-4 text-[16px] font-normal placeholder:text-neutral-400 focus:ring-2 focus:ring-black dark:bg-white/[0.07] dark:placeholder:text-neutral-500 dark:focus:ring-white"
			/>
		</label>
		<label class="flex flex-col gap-2 text-[15px] font-medium">
			Description
			<textarea
				name="description"
				rows="3"
				value={initial?.description ?? ''}
				placeholder="How would you describe this collection?"
				class="resize-none rounded-2xl border-0 bg-neutral-100 px-4 py-3 text-[16px] font-normal placeholder:text-neutral-400 focus:ring-2 focus:ring-black dark:bg-white/[0.07] dark:placeholder:text-neutral-500 dark:focus:ring-white"
			></textarea>
		</label>
		{#if message}
			<p class="text-sm text-red-600 dark:text-red-400" role="alert">{message}</p>
		{/if}
		<div class="mt-1 grid grid-cols-2 gap-3">
			<button
				type="button"
				onclick={onclose}
				class="h-12 rounded-full border border-neutral-200 text-[16px] font-medium transition-colors hover:bg-neutral-100 dark:border-white/15 dark:hover:bg-white/10"
			>
				Cancel
			</button>
			<button
				type="submit"
				class="h-12 rounded-full bg-black text-[16px] font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
			>
				{submitLabel}
			</button>
		</div>
	</form>
</Modal>
