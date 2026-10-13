// Everything that runs inside the browser page: reading the structure of the DOM, finding links
// and clickable controls, and locating the UI elements worth cropping.
//
// This file is bundled with Bun (see `pageInspectorScript` in capture.ts) and injected into every
// document, where it exposes `window.pageInspector`. The Node side calls it through
// `page.evaluate`. Cookie banners are not handled here: Playwright locators do that job better.
//
// Rects are in CSS px, relative to the top-left of the full page.
import type { ElementKind, Rect } from '#lib/types.ts';
import type { LinkRegion } from './rules.ts';

// --- shapes returned to the Node side ----------------------------------------------------------

export interface PageDetails {
	title: string;
	/** `og:site_name`, empty when the page doesn't set one. */
	siteName: string;
	description: string;
	icons: { href: string; rel: string; sizes: string }[];
}

export interface PageLink {
	href: string;
	text: string;
	region: LinkRegion;
	/** Undefined when the link isn't rendered (e.g. inside a closed menu). */
	rect?: Rect;
}

export interface ClickTarget {
	name: string;
	/** Lower ranks are tried first. */
	rank: number;
	rect: Rect;
}

export interface FoundElement {
	kind: ElementKind;
	name: string;
	rect: Rect;
	/** Buttons only: has a background or border, so it looks like a call to action. */
	looksLikeButton?: boolean;
}

/** Something a click revealed: a dialog, a dropdown menu, a drawer. */
export interface NewPanel {
	kind: 'dialog' | 'menu';
	/** True when the page marked it up as a dialog/menu/listbox, rather than us guessing. */
	hasPanelRole: boolean;
	name: string;
	rect: Rect;
}

// --- shared helpers --------------------------------------------------------------------------

/** Tags that are never part of what the user sees. */
const HIDDEN_TAGS = new Set(
	'SCRIPT STYLE NOSCRIPT TEMPLATE LINK META HEAD TITLE BR WBR SOURCE TRACK DATALIST AREA BASE'.split(' ')
);

function isVisible(element: Element): boolean {
	if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
	const box = element.getBoundingClientRect();
	return box.width > 0 && box.height > 0;
}

function roundToTenth(value: number): number {
	return Math.round(value * 10) / 10;
}

function pageRect(element: Element): Rect {
	const box = element.getBoundingClientRect();
	return {
		x: roundToTenth(box.left + window.scrollX),
		y: roundToTenth(box.top + window.scrollY),
		w: roundToTenth(box.width),
		h: roundToTenth(box.height)
	};
}

function cleanText(text: string | null | undefined, maxLength = 80): string {
	return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** Accessible name, approximated: aria-label, aria-labelledby, button value, text, title, image alt. */
function accessibleName(element: Element): string {
	const ariaLabel = cleanText(element.getAttribute('aria-label'));
	if (ariaLabel) return ariaLabel;

	const labelledByIds = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
	const labelledBy = cleanText(labelledByIds.map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
	if (labelledBy) return labelledBy;

	if (element instanceof HTMLInputElement && /^(button|submit)$/.test(element.type)) {
		return cleanText(element.value);
	}
	const text = cleanText((element as HTMLElement).innerText);
	if (text) return text;

	const title = cleanText(element.getAttribute('title'));
	if (title) return title;
	return cleanText(element.querySelector('img[alt]')?.getAttribute('alt'));
}

function firstHeadingText(root: Element): string {
	for (const heading of root.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
		if (!isVisible(heading)) continue;
		const text = cleanText((heading as HTMLElement).innerText);
		if (text) return text;
	}
	return '';
}

/** Alpha of a computed CSS colour. Chrome returns `rgba(r, g, b, a)` or, for newer spaces, `... / a)`. */
function colorAlpha(color: string): number {
	if (color === 'transparent') return 0;
	const slashAlpha = color.match(/\/\s*([\d.]+)(%?)\s*\)/);
	if (slashAlpha) return Number(slashAlpha[1]) / (slashAlpha[2] ? 100 : 1);
	const commaAlpha = color.match(/^rgba\([^)]*,\s*([\d.]+)\s*\)/);
	return commaAlpha ? Number(commaAlpha[1]) : 1;
}

// --- dom_sig skeleton ----------------------------------------------------------------------

/** Inline text formatting changes with the copy, not with the layout, so the skeleton ignores it. */
const INLINE_TEXT_TAGS = new Set('B I EM STRONG SMALL MARK SUB SUP U S CODE ABBR TIME SPAN'.split(' '));
/** Rendered as a single box: their internals are not page layout. */
const LEAF_TAGS = new Set(['SVG', 'IMG', 'PICTURE', 'VIDEO', 'CANVAS', 'IFRAME', 'INPUT']);
/** Deep enough to capture the layout, shallow enough to ignore widget internals. */
const MAX_SKELETON_DEPTH = 10;

function skeletonOf(element: Element, depth: number): string {
	const role = element.getAttribute('role');
	const label = element.tagName.toLowerCase() + (role ? `[${role}]` : '');
	if (depth >= MAX_SKELETON_DEPTH || LEAF_TAGS.has(element.tagName)) return label;

	const childSkeletons: string[] = [];
	let previousSkeleton = '';
	for (const child of element.children) {
		if (HIDDEN_TAGS.has(child.tagName) || !isVisible(child)) continue;
		// A <span> that wraps other elements is layout; one that only holds text is formatting.
		const isFormatting =
			INLINE_TEXT_TAGS.has(child.tagName) && (child.tagName !== 'SPAN' || child.children.length === 0);
		if (isFormatting) continue;

		const childSkeleton = skeletonOf(child, depth + 1);
		// Collapse runs of identical siblings so lists of different lengths produce the same skeleton.
		if (childSkeleton === previousSkeleton) continue;
		childSkeletons.push(childSkeleton);
		previousSkeleton = childSkeleton;
	}
	return childSkeletons.length ? `${label}(${childSkeletons.join(',')})` : label;
}

/** Nested `tag[role](children)` string of the visible structure; text, classes and ids are ignored. */
function domSkeleton(): string {
	return skeletonOf(document.body, 0);
}

// --- metadata, links and scrolling -----------------------------------------------------------

function pageDetails(): PageDetails {
	const metaContent = (selector: string) =>
		cleanText(document.querySelector<HTMLMetaElement>(selector)?.content, 400);
	const iconLinks = document.querySelectorAll<HTMLLinkElement>('link[rel*="icon" i]');
	return {
		title: cleanText(document.title, 300),
		siteName: metaContent('meta[property="og:site_name"]'),
		description: metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
		icons: [...iconLinks].map((link) => ({
			href: link.href,
			rel: link.rel.toLowerCase(),
			sizes: link.getAttribute('sizes') ?? ''
		}))
	};
}

/** Bounds the work on huge pages (mega footers, link farms). */
const MAX_LINKS = 800;

function links(): PageLink[] {
	const found: PageLink[] = [];
	for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
		if (found.length >= MAX_LINKS) break;
		// SVG <a> elements expose `href` as an SVGAnimatedString.
		if (typeof anchor.href !== 'string') continue;

		// Footer is checked first: footers are full of <nav>s, but those links are low value.
		let region: LinkRegion = 'other';
		if (anchor.closest('footer, [role="contentinfo"]')) region = 'footer';
		else if (anchor.closest('header, nav, [role="banner"], [role="navigation"]')) region = 'nav';
		else if (anchor.closest('main, [role="main"]')) region = 'main';

		found.push({
			href: anchor.href,
			text: accessibleName(anchor),
			region,
			rect: isVisible(anchor) ? pageRect(anchor) : undefined
		});
	}
	return found;
}

/** Time for lazy-load observers and scroll animations to react to each scroll step. */
const SCROLL_STEP_PAUSE_MS = 150;
/** Upper bound for waiting on images that started loading during the scroll. */
const IMAGE_WAIT_MS = 2500;

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Scrolls through the page to trigger lazy loading and scroll-linked reveals, then back to the top. */
async function scrollThrough(stepHeight: number, maxSteps: number): Promise<void> {
	let top = 0;
	for (let step = 0; step < maxSteps; step++) {
		// Re-read the height each time: lazy content makes the page grow while we scroll.
		if (top >= document.documentElement.scrollHeight) break;
		// `instant` because pages with `scroll-behavior: smooth` would otherwise animate.
		window.scrollTo({ top, behavior: 'instant' });
		await sleep(SCROLL_STEP_PAUSE_MS);
		top += stepHeight;
	}

	// Let images that just entered the viewport arrive, but never hang on a broken one.
	const loadingImages = [...document.images].filter((image) => !image.complete);
	const allSettled = Promise.all(
		loadingImages.map(
			(image) =>
				new Promise((resolve) => {
					image.addEventListener('load', resolve, { once: true });
					image.addEventListener('error', resolve, { once: true });
				})
		)
	);
	await Promise.race([allSettled, sleep(IMAGE_WAIT_MS)]);

	window.scrollTo({ top: 0, behavior: 'instant' });
	await sleep(SCROLL_STEP_PAUSE_MS);
}

// --- click targets and what a click revealed --------------------------------------------------

const HAS_POPUP = '[aria-haspopup]:not([aria-haspopup="false"])';

/** Selectors in the order they're tried (the index is the rank): header menu triggers reveal the most. */
const CLICK_TARGET_SELECTORS = [
	`header ${HAS_POPUP}, nav ${HAS_POPUP}, [role="banner"] ${HAS_POPUP}, [role="navigation"] ${HAS_POPUP}`,
	'header [aria-expanded="false"], nav [aria-expanded="false"]',
	'[role="tab"]:not([aria-selected="true"])',
	HAS_POPUP,
	'summary',
	'header button, nav button, [role="banner"] button, header [role="button"], nav [role="button"]',
	'[aria-expanded="false"]'
];

/** Form fields are only focused by a click, they reveal nothing. */
const NEVER_CLICK = 'input, select, textarea, [disabled], [aria-disabled="true"]';
/** Smaller controls are decorations or hit-test helpers. */
const MIN_CLICK_TARGET_SIZE = 8;

/**
 * Clickable controls in the first viewport. Only those, because clicking one further down would
 * scroll the page and make the before/after comparison meaningless.
 */
function clickTargets(): ClickTarget[] {
	const seen = new Set<Element>();
	const targets: ClickTarget[] = [];
	CLICK_TARGET_SELECTORS.forEach((selector, rank) => {
		for (const element of document.querySelectorAll(selector)) {
			if (seen.has(element)) continue;
			seen.add(element);
			if (element.matches(NEVER_CLICK) || !isVisible(element)) continue;

			// Plain links navigate, which is link discovery rather than a state. Popup triggers may be anchors.
			const opensSomething = element.matches(`${HAS_POPUP}, [aria-expanded]`);
			if (element.tagName === 'A' && element.hasAttribute('href') && !opensSomething) continue;

			// Any submit inside a form is off limits. A <button> without a type attribute is a submit.
			if (element instanceof HTMLButtonElement && element.form !== null && element.type === 'submit') continue;

			const box = element.getBoundingClientRect();
			const inFirstViewport =
				box.width >= MIN_CLICK_TARGET_SIZE &&
				box.height >= MIN_CLICK_TARGET_SIZE &&
				box.top >= 0 &&
				box.top < window.innerHeight &&
				box.left >= 0 &&
				box.left < window.innerWidth;
			const name = accessibleName(element);
			if (inFirstViewport && name) targets.push({ name, rank, rect: pageRect(element) });
		}
	});
	return targets;
}

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
const MENU_SELECTOR = '[role="menu"], [role="listbox"]';
/** A newly visible element covering this much of the viewport is a backdrop or full-screen overlay. */
const OVERLAY_VIEWPORT_RATIO = 0.85;
/** Tooltips, badges and tiny reveals are not worth a screen. */
const MIN_PANEL_WIDTH = 80;
const MIN_PANEL_HEIGHT = 40;
const MAX_PANELS = 3;

let elementsVisibleBeforeClick = new WeakSet<Element>();

/** Call right before a click, so `newPanels()` can tell what the click revealed. */
function snapshotVisible(): void {
	elementsVisibleBeforeClick = new WeakSet();
	for (const element of document.body.querySelectorAll('*')) {
		if (isVisible(element)) elementsVisibleBeforeClick.add(element);
	}
}

/** Panels that appeared since `snapshotVisible()`, biggest first. */
function newPanels(): NewPanel[] {
	const appeared = new Set<Element>();
	for (const element of document.body.querySelectorAll('*')) {
		if (HIDDEN_TAGS.has(element.tagName)) continue;
		if (!elementsVisibleBeforeClick.has(element) && isVisible(element)) appeared.add(element);
	}

	const panelRoles = `${DIALOG_SELECTOR}, ${MENU_SELECTOR}`;
	const panels = new Map<Element, NewPanel>();
	for (const root of appeared) {
		// Only the outermost new element: its descendants belong to the same panel.
		if (root.parentElement && appeared.has(root.parentElement)) continue;

		// A full-screen overlay is usually a backdrop around a dialog, so use the dialog inside it.
		// A bare backdrop (nothing to read or click) is not a panel at all.
		let panel: Element = root;
		const rootBox = root.getBoundingClientRect();
		const viewportArea = window.innerWidth * window.innerHeight;
		if (rootBox.width * rootBox.height >= viewportArea * OVERLAY_VIEWPORT_RATIO) {
			const dialog = root.matches(panelRoles) ? root : root.querySelector(panelRoles);
			const hasContent = root.querySelector('a, button, input, img, svg') || cleanText((root as HTMLElement).innerText);
			if (dialog && isVisible(dialog)) panel = dialog;
			else if (!hasContent) continue;
		}
		if (panels.has(panel)) continue;

		const box = panel.getBoundingClientRect();
		if (box.width < MIN_PANEL_WIDTH || box.height < MIN_PANEL_HEIGHT) continue;

		panels.set(panel, {
			kind: panel.matches(DIALOG_SELECTOR) ? 'dialog' : 'menu',
			hasPanelRole: panel.matches(panelRoles),
			name:
				cleanText(panel.getAttribute('aria-label'), 60) ||
				firstHeadingText(panel) ||
				cleanText((panel as HTMLElement).innerText, 40),
			rect: pageRect(panel)
		});
	}

	const area = (panel: NewPanel) => panel.rect.w * panel.rect.h;
	return [...panels.values()].sort((first, second) => area(second) - area(first)).slice(0, MAX_PANELS);
}

// --- UI elements -----------------------------------------------------------------------------

/** Shorter blocks are bars, dividers or spacers rather than a section of content. */
const MIN_SECTION_HEIGHT = 160;
/** Sections span (nearly) the page; narrower blocks are cards or sidebars. */
const MIN_SECTION_WIDTH_RATIO = 0.7;
/** A lone child that fills this much of its parent's height is a wrapper, not content. */
const WRAPPER_FILL_RATIO = 0.9;
/** A block whose large children fill this much of it is a layout wrapper around real sections. */
const WRAPPER_CHILDREN_FILL_RATIO = 0.8;
/** Guards against pathological nesting; real pages wrap sections in at most a handful of divs. */
const MAX_WRAPPER_DEPTH = 8;

/**
 * Children that take part in the page's vertical flow. Fixed headers, cookie bars and absolutely
 * positioned overlays are left out: they don't make up the page's sequence of sections.
 */
function flowChildren(parent: Element): Element[] {
	return [...parent.children].filter((child) => {
		if (HIDDEN_TAGS.has(child.tagName) || !isVisible(child)) return false;
		const position = getComputedStyle(child).position;
		return position !== 'fixed' && position !== 'absolute';
	});
}

/** Follows chains of single-child wrappers (`#app > div > div`) down to where the content branches. */
function unwrap(start: Element): Element {
	let element = start;
	for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth++) {
		const children = flowChildren(element);
		if (children.length !== 1) break;
		const fillsParent =
			children[0].getBoundingClientRect().height >= element.getBoundingClientRect().height * WRAPPER_FILL_RATIO;
		if (!fillsParent) break;
		element = children[0];
	}
	return element;
}

/**
 * Full-width blocks of the page, in order. `<main>` and generic layout wrappers that hold two or
 * more large blocks are looked into rather than returned as one giant section.
 */
function findSections(container: Element, wrapperDepth: number, viewportWidth: number): Element[] {
	const isLarge = (element: Element) => {
		const box = element.getBoundingClientRect();
		return box.height >= MIN_SECTION_HEIGHT && box.width >= viewportWidth * MIN_SECTION_WIDTH_RATIO;
	};

	const sections: Element[] = [];
	for (const child of flowChildren(unwrap(container))) {
		if (!isLarge(child)) continue;

		const inner = unwrap(child);
		const largeChildren = flowChildren(inner).filter(isLarge);
		const largeChildrenHeight = largeChildren.reduce(
			(sum, largeChild) => sum + largeChild.getBoundingClientRect().height,
			0
		);
		// A <section> or <article> with two big children is itself one section, so only <main> and
		// untagged wrappers (page, content, layout...) whose children fill them are split up.
		const isSemanticBlock = /^(HEADER|FOOTER|NAV|SECTION|ARTICLE|ASIDE)$/.test(inner.tagName);
		const isWrapper =
			inner.matches('main, [role="main"]') ||
			(!isSemanticBlock &&
				largeChildrenHeight >= inner.getBoundingClientRect().height * WRAPPER_CHILDREN_FILL_RATIO);

		if (isWrapper && largeChildren.length >= 2 && wrapperDepth < MAX_WRAPPER_DEPTH) {
			sections.push(...findSections(inner, wrapperDepth + 1, viewportWidth));
		} else {
			sections.push(child);
		}
	}
	return sections;
}

/** Pages rarely have more than a main nav, a secondary nav and a couple of footer navs. */
const MAX_NAVS = 4;
/** A <header> or <footer> inside one of these belongs to that block, not to the page. */
const SECTIONING_ANCESTORS = 'article, aside, main, section, [role="main"]';

// Native buttons smaller than this are icon fragments or hit targets, not buttons worth a crop.
const MIN_BUTTON_WIDTH = 24;
const MIN_BUTTON_HEIGHT = 20;
/** Taller "buttons" are cards or tiles that happen to be clickable. */
const MAX_BUTTON_HEIGHT = 72;
/** A link styled as a button is at least this tall; shorter is inline text. */
const MIN_LINK_BUTTON_HEIGHT = 28;
/** Total horizontal padding; links in a text flow have none, buttons have at least a few px a side. */
const MIN_LINK_BUTTON_PADDING = 12;
/** Button labels are short ("Get started"); long text is a sentence or a card title. */
const MAX_BUTTON_NAME_LENGTH = 40;
/** A background or border colour below this alpha is effectively invisible. */
const MIN_VISIBLE_ALPHA = 0.05;
const MIN_BORDER_ALPHA = 0.1;

/** A "table" with fewer rows is layout markup. */
const MIN_TABLE_ROWS = 2;

/** True when all four sides have a visible border (a button outline, not an underline). */
function hasButtonBorder(style: CSSStyleDeclaration): boolean {
	return ['top', 'right', 'bottom', 'left'].every((side) => {
		const width = parseFloat(style.getPropertyValue(`border-${side}-width`));
		const borderStyle = style.getPropertyValue(`border-${side}-style`);
		return width >= 1 && borderStyle !== 'none' && colorAlpha(style.getPropertyValue(`border-${side}-color`)) > MIN_BORDER_ALPHA;
	});
}

/** Every UI element worth cropping, unfiltered: the Node side drops offscreen ones and duplicates. */
function findElements(): { pageHeight: number; elements: FoundElement[] } {
	const viewportWidth = document.documentElement.clientWidth;
	const elements: FoundElement[] = [];
	const add = (kind: ElementKind, element: Element, name: string, looksLikeButton?: boolean) => {
		elements.push({ kind, name, rect: pageRect(element), looksLikeButton });
	};

	for (const section of findSections(document.body, 0, viewportWidth)) {
		add('section', section, firstHeadingText(section) || cleanText((section as HTMLElement).innerText, 60));
	}

	for (const header of document.querySelectorAll('header, [role="banner"]')) {
		if (isVisible(header) && !header.parentElement?.closest(SECTIONING_ANCESTORS)) add('header', header, '');
	}
	for (const footer of document.querySelectorAll('footer, [role="contentinfo"]')) {
		if (isVisible(footer) && !footer.parentElement?.closest(SECTIONING_ANCESTORS)) add('footer', footer, '');
	}
	const visibleNavs = [...document.querySelectorAll('nav, [role="navigation"]')].filter(isVisible);
	for (const nav of visibleNavs.slice(0, MAX_NAVS)) {
		// Unlabelled navs are named after their first links, e.g. "Product / Pricing / Docs".
		const firstLinks = [...nav.querySelectorAll<HTMLElement>('a')]
			.filter(isVisible)
			.slice(0, 3)
			.map((link) => cleanText(link.innerText, 20))
			.filter(Boolean);
		add('nav', nav, cleanText(nav.getAttribute('aria-label')) || firstLinks.join(' / '));
	}

	const buttonSelector = 'button, [role="button"], input[type="button"], input[type="submit"], a[href]';
	for (const button of document.querySelectorAll(buttonSelector)) {
		if (!isVisible(button)) continue;
		const name = accessibleName(button);
		if (!name || name.length > MAX_BUTTON_NAME_LENGTH) continue;

		const box = button.getBoundingClientRect();
		if (box.height > MAX_BUTTON_HEIGHT) continue;
		const style = getComputedStyle(button);
		const hasFill = colorAlpha(style.backgroundColor) > MIN_VISIBLE_ALPHA;
		const dressedAsButton = hasFill || hasButtonBorder(style);
		if (button.tagName === 'A') {
			// A link is only a button when it is dressed like one: fill or border, padding and a
			// button-like height. Everything else is text.
			const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
			if (!dressedAsButton || padding < MIN_LINK_BUTTON_PADDING || box.height < MIN_LINK_BUTTON_HEIGHT) continue;
		} else if (box.width < MIN_BUTTON_WIDTH || box.height < MIN_BUTTON_HEIGHT) {
			continue;
		}
		add('button', button, name, dressedAsButton);
	}

	// Text-like fields only: checkboxes, radios and buttons aren't worth a crop of their own.
	const nonTextTypes = ['hidden', 'checkbox', 'radio', 'submit', 'button', 'image', 'reset', 'file', 'range', 'color'];
	const inputSelector = 'input' + nonTextTypes.map((type) => `:not([type="${type}"])`).join('') + ', select, textarea';
	for (const input of document.querySelectorAll<HTMLInputElement>(inputSelector)) {
		if (!isVisible(input)) continue;
		const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
		const name =
			accessibleName(input) ||
			cleanText(label?.textContent) ||
			cleanText(input.placeholder) ||
			cleanText(input.getAttribute('name'));
		add('input', input, name);
	}

	for (const form of document.querySelectorAll('form')) {
		if (isVisible(form)) add('form', form, cleanText(form.getAttribute('aria-label')) || firstHeadingText(form));
	}
	for (const table of document.querySelectorAll('table, [role="table"], [role="grid"]')) {
		if (!isVisible(table) || table.querySelectorAll('tr, [role="row"]').length < MIN_TABLE_ROWS) continue;
		add('table', table, cleanText(table.querySelector('caption')?.textContent) || cleanText(table.getAttribute('aria-label')));
	}
	for (const dialog of document.querySelectorAll(DIALOG_SELECTOR)) {
		if (isVisible(dialog)) add('dialog', dialog, cleanText(dialog.getAttribute('aria-label')) || firstHeadingText(dialog));
	}
	for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
		if (isVisible(menu)) add('menu', menu, cleanText(menu.getAttribute('aria-label')));
	}

	return {
		pageHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
		elements
	};
}

// --- entry point -----------------------------------------------------------------------------

const pageInspector = {
	domSkeleton,
	pageDetails,
	links,
	scrollThrough,
	clickTargets,
	snapshotVisible,
	newPanels,
	findElements
};

export type PageInspector = typeof pageInspector;

declare global {
	interface Window {
		pageInspector?: PageInspector;
	}
}

window.pageInspector = pageInspector;
