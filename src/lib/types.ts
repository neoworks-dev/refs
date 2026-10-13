// Plain (JSON) shapes of the records in db/schema.surql, as returned through `plain()`:
// record links are id strings, datetimes are ISO strings.

export type Viewport = 'desktop' | 'mobile';
export const VIEWPORTS: Viewport[] = ['desktop', 'mobile'];

export type CrawlStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type ElementKind =
	| 'section'
	| 'header'
	| 'footer'
	| 'nav'
	| 'button'
	| 'input'
	| 'form'
	| 'dialog'
	| 'menu'
	| 'table';

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Site {
	id: string;
	name: string;
	slug: string;
	url: string;
	host: string;
	description?: string;
	icon?: string;
	cover: { desktop?: string; mobile?: string };
	created_at: string;
	updated_at: string;
}

export interface Crawl {
	id: string;
	site: string;
	viewport: Viewport;
	status: CrawlStatus;
	max_screens: number;
	max_depth: number;
	screens: number;
	elements: number;
	activity?: string;
	error?: string;
	created_at: string;
	started_at?: string;
	finished_at?: string;
}

export interface Screen {
	id: string;
	site: string;
	crawl: string;
	viewport: Viewport;
	kind: 'page' | 'state';
	url: string;
	path: string;
	title: string;
	depth: number;
	seq: number;
	width: number;
	height: number;
	full_height: number;
	media: { viewport: string; full: string; thumb: string };
	dom_sig: string;
	image_hash: string;
	page_type?: string;
	description?: string;
	captured_at: string;
}

export interface UiElement {
	id: string;
	site: string;
	screen: string;
	viewport: Viewport;
	kind: ElementKind;
	name: string;
	rect: Rect;
	media: string;
	label?: string;
	captured_at: string;
}

export interface Action {
	id: string;
	in: string;
	out: string;
	crawl: string;
	kind: 'navigate' | 'click';
	label: string;
	rect?: Rect;
}
