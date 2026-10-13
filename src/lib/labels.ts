// How the database's vocabularies read on screen.
import type { ElementKind } from './types.ts';

/** Element kinds in the order the filter chips show them, with their plural display names. */
export const kindLabels: Record<ElementKind, string> = {
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

export const kinds = Object.keys(kindLabels) as ElementKind[];

// Words of the model's vocabularies that read better in capitals.
const ACRONYMS = new Set(['cta', 'faq']);

/** "how_it_works" becomes "How it works" and "footer_cta" becomes "Footer CTA". */
export function humanise(value: string): string {
	const words = value.split('_').map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word));
	return words.join(' ').replace(/^./, (first) => first.toUpperCase());
}
