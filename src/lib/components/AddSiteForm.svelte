<script lang="ts">
	import { enhance } from '$app/forms';

	type FormErrors = { url?: string; viewports?: string; max_screens?: string };
	type FailureData = { errors?: FormErrors; values?: { url?: string } };

	// `initial` carries the server's result when the form was submitted without JS.
	let { initial, onsuccess }: { initial?: FailureData; onsuccess?: () => void } = $props();

	// Only the first render's server result matters; after that the enhanced submit owns the state.
	// svelte-ignore state_referenced_locally
	let errors = $state<FormErrors>(initial?.errors ?? {});
	// svelte-ignore state_referenced_locally
	let url = $state(initial?.values?.url ?? '');
	let pending = $state(false);
</script>

<form
	method="POST"
	action="/add"
	novalidate
	class="flex flex-col gap-7"
	use:enhance={() => {
		pending = true;
		return async ({ result, update }) => {
			pending = false;
			if (result.type === 'failure') {
				// Keep what the user typed; only the messages change.
				errors = (result.data as FailureData | undefined)?.errors ?? {};
				return;
			}
			errors = {};
			if (result.type === 'redirect') onsuccess?.();
			await update();
		};
	}}
>
	<div class="flex flex-col gap-2.5">
		<label
			for="add-url"
			class="text-center text-[32px] leading-[1.1] font-semibold tracking-[-0.045em] text-balance sm:text-[40px]"
		>
			What's the URL?
		</label>
		<p class="text-center text-[15px] text-neutral-500 dark:text-neutral-400">
			We'll capture its pages and UI elements.
		</p>
	</div>

	<div class="flex flex-col gap-2">
		<!-- svelte-ignore a11y_autofocus -->
		<input
			id="add-url"
			name="url"
			type="text"
			inputmode="url"
			autocomplete="off"
			autocapitalize="none"
			spellcheck="false"
			autofocus
			bind:value={url}
			placeholder="example.com"
			aria-invalid={errors.url ? 'true' : undefined}
			aria-describedby={errors.url ? 'add-url-error' : undefined}
			class={[
				'h-14 w-full rounded-full border-0 bg-neutral-100 px-6 text-[17px] placeholder:text-neutral-400 focus:ring-2 dark:bg-white/[0.07] dark:placeholder:text-neutral-500',
				errors.url && 'ring-2 ring-red-500 focus:ring-red-500',
				!errors.url && 'focus:ring-black dark:focus:ring-white'
			]}
		/>
		{#if errors.url}
			<p id="add-url-error" class="px-4 text-sm text-red-600 dark:text-red-400" role="alert">
				{errors.url}
			</p>
		{/if}
	</div>

	<fieldset class="flex flex-col gap-3">
		<legend class="mb-3 text-[15px] font-medium">Viewports</legend>
		<div class="flex gap-2.5 sm:gap-3">
			{#each [{ value: 'desktop', label: 'Desktop', size: '1440 × 900' }, { value: 'mobile', label: 'Mobile', size: '390 × 844' }] as viewport (viewport.value)}
				<label
					class="flex flex-1 cursor-pointer items-center gap-3 rounded-2xl border border-neutral-200 px-3.5 py-3.5 text-[15px] font-medium transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-black has-[:checked]:border-black has-[:checked]:bg-neutral-50 sm:px-4 dark:border-white/15 dark:focus-within:outline-white dark:has-[:checked]:border-white dark:has-[:checked]:bg-white/5"
				>
					<input
						type="checkbox"
						name="viewport"
						value={viewport.value}
						checked
						class="size-[18px] rounded-md border-neutral-300 text-black focus:ring-black dark:border-white/25 dark:bg-transparent dark:text-neutral-500 dark:focus:ring-white"
					/>
					<span class="flex flex-col leading-tight">
						{viewport.label}
						<span
							class="text-[13px] font-normal whitespace-nowrap text-neutral-500 dark:text-neutral-400"
							>{viewport.size}</span
						>
					</span>
				</label>
			{/each}
		</div>
		{#if errors.viewports}
			<p class="px-1 text-sm text-red-600 dark:text-red-400" role="alert">{errors.viewports}</p>
		{/if}
	</fieldset>

	<div class="flex items-center justify-between gap-6">
		<label for="add-max" class="flex flex-col leading-tight">
			<span class="text-[15px] font-medium">Max screens</span>
			<span class="text-[13px] text-neutral-500 dark:text-neutral-400"
				>Per viewport, states included</span
			>
		</label>
		<div class="flex flex-col items-end gap-1">
			<input
				id="add-max"
				name="max_screens"
				type="number"
				min="1"
				max="500"
				value="30"
				aria-invalid={errors.max_screens ? 'true' : undefined}
				class="h-11 w-28 rounded-full border-0 bg-neutral-100 px-5 text-right text-[15px] focus:ring-2 focus:ring-black dark:bg-white/[0.07] dark:focus:ring-white"
			/>
			{#if errors.max_screens}
				<p class="text-sm text-red-600 dark:text-red-400" role="alert">{errors.max_screens}</p>
			{/if}
		</div>
	</div>

	<button
		type="submit"
		disabled={pending}
		class="inline-flex h-14 w-full items-center justify-center rounded-full bg-black px-8 text-[17px] font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200 dark:focus-visible:outline-white"
	>
		{pending ? 'Adding…' : 'Add site'}
	</button>
</form>
