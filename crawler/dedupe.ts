// Turns the raw elements found in the page into the ones worth storing: drops the invisible and
// the duplicated, keeps the more specific of overlapping kinds, and thins out repeated buttons.
import type { ElementKind, Rect, Viewport } from '#lib/types.ts';
import type { FoundElement, NewPanel } from './page.ts';

/** Elements smaller than this in either direction are icons or hidden helpers. */
const MIN_ELEMENT_SIZE = 12;
/** Elements with less than this share of their area inside the page image are mostly offscreen. */
const MIN_VISIBLE_SHARE = 0.6;
/** Two rects overlapping more than this (intersection over union) describe the same thing. */
const DUPLICATE_IOU = 0.9;
/** A state's element only counts as "already on the page" above this overlap with the same kind. */
const SAME_AS_BASE_IOU = 0.8;
/** Per-screen caps. Real pages have a handful of sections; the caps only stop runaway markup. */
const MAX_BUTTONS_PER_SCREEN = 12;
const MAX_INPUTS_PER_SCREEN = 8;
const MAX_SECTIONS_PER_SCREEN = 24;

/** When two rects are duplicates, the kind later in this list wins. */
const SPECIFICITY: ElementKind[] = ['section', 'footer', 'header', 'nav', 'form', 'table', 'menu', 'dialog', 'input', 'button'];

export function intersectionOverUnion(first: Rect, second: Rect): number {
	const overlapWidth = Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x);
	const overlapHeight = Math.min(first.y + first.h, second.y + second.h) - Math.max(first.y, second.y);
	if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
	const intersection = overlapWidth * overlapHeight;
	return intersection / (first.w * first.h + second.w * second.h - intersection);
}

/** Identity of a button across pages: its label and size, so 500 "Learn more" buttons collapse to one. */
export function buttonKey(viewport: Viewport, name: string, rect: Rect): string {
	const normalizedName = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
	// Rounded to 2px: the same button measures slightly differently across pages.
	return `${viewport}|${normalizedName}|${Math.round(rect.w / 2)}x${Math.round(rect.h / 2)}`;
}

interface SelectOptions {
	found: FoundElement[];
	/** Size of the full-page image in CSS px. */
	imageWidth: number;
	imageHeight: number;
	viewport: Viewport;
	/** Button keys already stored for the site; new ones are added as they are selected. */
	knownButtons: Set<string>;
	/** For state screens: the base page's elements, which are not "new". */
	baseline?: FoundElement[];
	/** For state screens: what the click revealed. */
	newPanels?: NewPanel[];
}

export function selectElements(options: SelectOptions): FoundElement[] {
	const { imageWidth, imageHeight, baseline } = options;
	const candidates = [
		...options.found.map((element) => ({ element, isPanel: false })),
		...(options.newPanels ?? []).map((panel) => ({
			element: { kind: panel.kind, name: panel.name, rect: panel.rect } satisfies FoundElement,
			isPanel: true
		}))
	];

	// Visible: clamp to the image, then drop what's tiny, mostly offscreen or taller than the page.
	const visible: { element: FoundElement; isPanel: boolean }[] = [];
	for (const { element, isPanel } of candidates) {
		const { x, y, w, h } = element.rect;
		const left = Math.max(0, x);
		const top = Math.max(0, y);
		const right = Math.min(imageWidth, x + w);
		const bottom = Math.min(imageHeight, y + h);
		if (right - left < MIN_ELEMENT_SIZE || bottom - top < MIN_ELEMENT_SIZE) continue;
		if (((right - left) * (bottom - top)) / (w * h) < MIN_VISIBLE_SHARE) continue;
		// Taller than the (capped) page: it can only be a layout wrapper.
		if (h > imageHeight) continue;

		// State screens keep the panels and what is new relative to the page underneath.
		const alreadyOnPage = baseline?.some(
			(base) => base.kind === element.kind && intersectionOverUnion(base.rect, element.rect) > SAME_AS_BASE_IOU
		);
		if (alreadyOnPage && !isPanel) continue;

		visible.push({ element: { ...element, rect: { x: left, y: top, w: right - left, h: bottom - top } }, isPanel });
	}

	// Near-duplicate rects: keep the more specific kind (a <nav> over the <section> around it).
	const bySpecificity = visible
		.map(({ element }) => element)
		.sort((first, second) => SPECIFICITY.indexOf(second.kind) - SPECIFICITY.indexOf(first.kind));
	const distinct: FoundElement[] = [];
	for (const element of bySpecificity) {
		if (distinct.some((kept) => intersectionOverUnion(kept.rect, element.rect) > DUPLICATE_IOU)) continue;
		distinct.push(element);
	}

	const reading = (first: FoundElement, second: FoundElement) => first.rect.y - second.rect.y || first.rect.x - second.rect.x;
	const selected = [
		...distinct.filter((element) => !['button', 'input', 'section'].includes(element.kind)),
		...distinct.filter((element) => element.kind === 'section').sort(reading).slice(0, MAX_SECTIONS_PER_SCREEN),
		...distinct.filter((element) => element.kind === 'input').sort(reading).slice(0, MAX_INPUTS_PER_SCREEN),
		...selectButtons(distinct.filter((element) => element.kind === 'button'), options)
	];
	return selected.sort(reading);
}

/** New buttons only (not stored for this site yet), call-to-action looking ones first. */
function selectButtons(buttons: FoundElement[], options: SelectOptions): FoundElement[] {
	const ordered = [...buttons].sort((first, second) => Number(Boolean(second.looksLikeButton)) - Number(Boolean(first.looksLikeButton)) || first.rect.y - second.rect.y);
	const selected: FoundElement[] = [];
	for (const button of ordered) {
		if (selected.length >= MAX_BUTTONS_PER_SCREEN) break;
		const key = buttonKey(options.viewport, button.name, button.rect);
		if (options.knownButtons.has(key)) continue;
		options.knownButtons.add(key);
		selected.push(button);
	}
	return selected;
}
