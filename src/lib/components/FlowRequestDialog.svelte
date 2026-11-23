<script lang="ts">
	import { X } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import type { Viewport } from '../types.ts';
	import Modal from './Modal.svelte';

	type Props = {
		/** The viewports the site has been explored in; a request only runs where there is a crawl. */
		viewports: Viewport[];
		initialViewport: Viewport;
		onclose: () => void;
	};

	let { viewports, initialViewport, onclose }: Props = $props();

	let message = $state<string>();
	let pending = $state(false);
</script>

<Modal
	label="Request a flow"
	{onclose}
	class="w-[min(92vw,34rem)] rounded-[2rem] bg-white px-6 pt-16 pb-8 shadow-2xl sm:px-10 sm:pb-10 dark:bg-neutral-900 dark:ring-1 dark:ring-white/10"
>
	<button
		type="button"
		aria-label="Close"
		onclick={onclose}
		class="absolute top-5 right-5 flex size-10 items-center justify-center rounded-full bg-neutral-100 transition-colors hover:bg-neutral-200 dark:bg-white/10 dark:hover:bg-white/20"
	>
		<X class="size-[18px]" strokeWidth={2.25} />
	</button>

	<form
		method="POST"
		action="?/requestFlow"
		class="flex flex-col gap-7"
		use:enhance={() => {
			pending = true;
			return async ({ result, update }) => {
				pending = false;
				if (result.type === 'failure') {
					// Keep what the user typed; only the message changes.
					message = (result.data as { message?: string } | undefined)?.message;
					return;
				}
				await update({ reset: false });
				onclose();
			};
		}}
	>
		<div class="flex flex-col gap-2.5">
			<label
				for="flow-request-goal"
				class="text-center text-[32px] leading-[1.1] font-semibold tracking-[-0.045em] text-balance sm:text-[40px]"
			>
				Which flow should we capture?
			</label>
			<p class="text-center text-[15px] text-neutral-500 dark:text-neutral-400">
				Describe what a visitor does. The model tries it in a browser and saves the screens along
				the way.
			</p>
		</div>

		<div class="flex flex-col gap-2">
			<!-- svelte-ignore a11y_autofocus -->
			<textarea
				id="flow-request-goal"
				name="goal"
				required
				autofocus
				rows="3"
				placeholder="Switch the pricing to yearly and open the Team plan"
				aria-invalid={message ? 'true' : undefined}
				class={[
					'w-full resize-none rounded-3xl border-0 bg-neutral-100 px-6 py-4 text-[17px] placeholder:text-neutral-400 focus:ring-2 dark:bg-white/[0.07] dark:placeholder:text-neutral-500',
					message && 'ring-2 ring-red-500 focus:ring-red-500',
					!message && 'focus:ring-black dark:focus:ring-white'
				]}></textarea>
			{#if message}
				<p class="px-4 text-sm text-red-600 dark:text-red-400" role="alert">{message}</p>
			{/if}
		</div>

		{#if viewports.length === 1}
			<input type="hidden" name="viewport" value={viewports[0]} />
		{:else}
			<fieldset class="flex flex-col gap-3">
				<legend class="mb-3 text-[15px] font-medium">Viewport</legend>
				<div class="flex gap-2.5 sm:gap-3">
					{#each viewports as viewport (viewport)}
						<label
							class="flex flex-1 cursor-pointer items-center gap-3 rounded-2xl border border-neutral-200 px-3.5 py-3.5 text-[15px] font-medium capitalize transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-black has-[:checked]:border-black has-[:checked]:bg-neutral-50 sm:px-4 dark:border-white/15 dark:focus-within:outline-white dark:has-[:checked]:border-white dark:has-[:checked]:bg-white/5"
						>
							<input
								type="radio"
								name="viewport"
								value={viewport}
								checked={viewport === initialViewport}
								class="size-[18px] border-neutral-300 text-black focus:ring-black dark:border-white/25 dark:bg-transparent dark:text-neutral-500 dark:focus:ring-white"
							/>
							{viewport}
						</label>
					{/each}
				</div>
			</fieldset>
		{/if}

		<button
			type="submit"
			disabled={pending}
			class="inline-flex h-14 w-full items-center justify-center rounded-full bg-black px-8 text-[17px] font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200 dark:focus-visible:outline-white"
		>
			{pending ? 'Requesting…' : 'Request flow'}
		</button>
	</form>
</Modal>
