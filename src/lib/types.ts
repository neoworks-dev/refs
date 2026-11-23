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

// The fixed vocabularies the models answer in, here so the app can filter by them and the crawler's
// prompts can list them. The element labels of the other kinds live with the labelling prompt.
export const PAGE_TYPES = [
	'home',
	'pricing',
	'features',
	'product',
	'about',
	'blog_index',
	'blog_post',
	'docs',
	'signup',
	'login',
	'onboarding',
	'checkout',
	'cart',
	'settings',
	'dashboard',
	'search',
	'contact',
	'careers',
	'legal',
	'error',
	'other'
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/**
 * Flow categories, following Mobbin's flow tree adapted to websites. The model reads the
 * descriptions, because a bare name like "exploring_features" is too easy to use for any run of
 * marketing pages, and they decide between near neighbours.
 */
export const FLOW_CATEGORY_DESCRIPTIONS = {
	onboarding: 'first-run setup after signing up: welcome steps, preferences, invitations',
	signing_up: 'creating an account or starting a free trial: registration forms',
	logging_in: 'signing in, password reset and verification steps',
	checkout: 'cart, shipping, payment and order confirmation',
	subscribing: 'choosing a plan and paying for it or upgrading',
	pricing_and_plans: 'comparing prices, plans and tiers',
	searching: 'typing a query and looking at the results',
	filtering_and_sorting: 'narrowing or ordering a list with filters, tabs or sort controls',
	browsing_products:
		'looking through products, offers, deals, recipes or listings, and opening one',
	reading_content: 'reading articles, blog posts, documentation or guides',
	exploring_features:
		'learning what a product does, page by page: product, solution and feature pages',
	contacting: 'reaching the company: contact, sales or demo request forms',
	getting_help: 'support, help center, FAQ and status pages',
	customer_stories: 'case studies, testimonials and customer lists',
	settings: 'account, profile or preference settings',
	other: 'none of the above'
} as const;
export const FLOW_CATEGORIES = Object.keys(FLOW_CATEGORY_DESCRIPTIONS) as FlowCategory[];
export type FlowCategory = keyof typeof FLOW_CATEGORY_DESCRIPTIONS;

export const SECTION_LABELS = [
	'hero',
	'features',
	'pricing',
	'testimonials',
	'logos',
	'faq',
	'cta',
	'stats',
	'team',
	'footer_cta',
	'gallery',
	'comparison',
	'how_it_works',
	'newsletter',
	'other'
] as const;
export type SectionLabel = (typeof SECTION_LABELS)[number];

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
	max_trajectories: number;
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
	/** Captured while logged in to the site's demo account. */
	signed_in?: boolean;
	captured_at: string;
}

export interface UiElement {
	id: string;
	site: string;
	crawl: string;
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
	region?: 'nav' | 'main' | 'footer' | 'other';
	rect?: Rect;
}

export interface FlowStep {
	screen: string;
	/** The action that led here; missing on the first step. */
	action?: string;
	caption?: string;
	/** Goal flows only: why the model took this step. */
	thought?: string;
}

export type FlowOutcome = 'done' | 'gave_up' | 'blocked' | 'stuck' | 'step_limit' | 'error';

export interface FlowVideo {
	/** Media key of the recording. */
	media: string;
	width: number;
	height: number;
	/** Length in seconds. */
	duration: number;
	/** Second at which each step was reached, in step order; shorter than the flow if it failed. */
	steps: number[];
	/** Why the replay stopped early. */
	failed?: string;
	recorded_at: string;
}

export interface Flow {
	id: string;
	site: string;
	crawl: string;
	viewport: Viewport;
	/** 'goal' was planned by the model, 'request' asked for by a person, 'structure' is legacy. */
	source: 'structure' | 'goal' | 'request';
	title: string;
	category?: string;
	steps: FlowStep[];
	/** Goal and requested flows: the goal the model set itself or was given, and how it ended. */
	goal?: string;
	outcome?: FlowOutcome;
	outcome_reason?: string;
	/** Goal flows only: logged in to the demo account for at least one step. */
	signed_in?: boolean;
	video?: FlowVideo;
	created_at: string;
}

export type FlowRequestStatus = 'queued' | 'running' | 'done' | 'failed';

export interface FlowRequest {
	id: string;
	site: string;
	viewport: Viewport;
	goal: string;
	status: FlowRequestStatus;
	/** The flow the attempt produced, once there is one. */
	flow?: string;
	error?: string;
	created_at: string;
	started_at?: string;
	finished_at?: string;
}

export interface Collection {
	id: string;
	name: string;
	slug: string;
	description?: string;
	created_at: string;
	updated_at: string;
}

/** A collection's link to one saved screen, element or flow. */
export interface Saved {
	id: string;
	in: string;
	out: string;
	saved_at: string;
}

export interface ApiKey {
	id: string;
	name: string;
	hash: string;
	created_at: string;
	last_used_at?: string;
	revoked_at?: string;
}

export type AccountStatus = 'pending' | 'active' | 'failed';

/** The demo account exploration signs up and logs in with on one site. */
export interface Account {
	id: string;
	site: string;
	email: string;
	password: string;
	status: AccountStatus;
	failure?: string;
	/** Playwright storage state as JSON, so a later crawl starts logged in. */
	storage_state?: string;
	created_at: string;
	logged_in_at?: string;
}

/** A goal exploration is trying right now, as the live panel shows it. The screenshot is served separately. */
export interface LiveGoal {
	id: string;
	crawl: string;
	site: string;
	viewport: Viewport;
	/** The worker trying it, when several goals run at once. */
	slot: number;
	goal: string;
	step: number;
	thought?: string;
	/** The last action in words, e.g. `click "Pricing"`. */
	action?: string;
	signed_in?: boolean;
	updated_at: string;
}
