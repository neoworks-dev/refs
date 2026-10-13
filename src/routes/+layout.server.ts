import { getPickerData } from '#lib/server/collections.ts';
import type { LayoutServerLoad } from './$types';

// Every save button on every page reads this, so it is loaded once here. A form action that
// changes a collection reruns it, which is what moves the checkmarks.
export const load: LayoutServerLoad = () => getPickerData();
