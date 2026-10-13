// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { PickerData } from '#lib/server/collections.ts';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// The root layout's data, which the save buttons read through `page.data`.
		interface PageData extends PickerData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
