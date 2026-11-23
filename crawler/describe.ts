// The prompts that turn captured screenshots into the library's metadata: a page type and description
// per screen, a label per element crop, and a category, title and captions per flow. Each call asks
// the model for JSON against a schema, which the server enforces while decoding, so the answers
// always parse and the fixed vocabularies (the app filters by them) can never grow by accident.
import {
	FLOW_CATEGORIES,
	FLOW_CATEGORY_DESCRIPTIONS,
	PAGE_TYPES,
	SECTION_LABELS,
	type ElementKind,
	type FlowCategory
} from '#lib/types.ts';
import { chat, imageDataUri, type ModelEndpoint } from '#lib/server/models.ts';

/**
 * Labels per element kind. The kinds are the ones in db/schema.surql, and every list ends with
 * "other" so the model always has an honest answer when nothing fits.
 */
export const ELEMENT_LABELS: Record<ElementKind, readonly string[]> = {
	section: SECTION_LABELS,
	header: ['top_nav', 'announcement_bar', 'hero_header', 'other'],
	footer: ['simple_footer', 'link_columns_footer', 'newsletter_footer', 'other'],
	nav: ['top_nav', 'sidebar', 'tabs', 'breadcrumbs', 'pagination', 'other'],
	button: ['primary', 'secondary', 'ghost', 'icon', 'link', 'other'],
	input: ['text', 'search', 'email', 'password', 'select', 'checkbox', 'other'],
	form: ['login', 'signup', 'contact', 'newsletter', 'search', 'checkout', 'settings', 'other'],
	dialog: ['cookie_consent', 'signup_modal', 'login_modal', 'confirmation', 'promo', 'other'],
	menu: ['dropdown', 'mega_menu', 'context_menu', 'other'],
	table: ['pricing_table', 'comparison_table', 'data_table', 'other']
};

// Screenshots are shrunk before they reach the model (see `imageDataUri`), to what judging a
// layout needs. Element crops can be tiny (a button) or huge (a full-height section).
const SCREEN_MAX_SIDE = 1280;
const ELEMENT_MAX_SIDE = 1024;
// A flow sends several screenshots in one request, and the llama.cpp profile has a 16k context. At
// 768 px a desktop page is about 450 image tokens and a phone page about 350, so the cap below
// leaves room for the prompt and the captions. Layout and headings are still readable at this size.
const FLOW_MAX_SIDE = 768;
// 8 screenshots take about 4k tokens, so a flow of up to 16 would still fit, but small models
// lose track of order and caption the wrong screenshot with that many. The first steps say most
// about what a flow is for, so the rest are left out and get no caption.
export const MAX_FLOW_STEPS = 8;
// Link text can be a whole paragraph (a card that is one big link), and a prompt needs only a hint.
const MAX_ACTION_LABEL_CHARACTERS = 80;

// Every answer also carries a confidence that nothing reads. The prompts were tuned with it, and
// without it the classifier answered "other" for landing pages it otherwise calls "home".
const CONFIDENCE = { type: 'number', minimum: 0, maximum: 1 };
const CONFIDENCE_PROMPT = 'Give your confidence as a number from 0 to 1.';

// Output budgets: the schema bounds the answer, these only leave room for it to finish.
const CLASSIFICATION_MAX_TOKENS = 300;
const ELEMENT_LABEL_MAX_TOKENS = 60;
const FLOW_TOKENS_PER_STEP = 150;
const FLOW_TITLE_AND_CATEGORY_TOKENS = 150;

/** What a screen is for and what it shows. */
export async function classifyScreen(
	endpoint: ModelEndpoint,
	screen: { image: Uint8Array; url: string; title: string }
): Promise<{ pageType: string; description: string }> {
	const { uri } = await imageDataUri(screen.image, SCREEN_MAX_SIDE);
	const schema = {
		type: 'object',
		properties: {
			page_type: { type: 'string', enum: PAGE_TYPES },
			description: { type: 'string' },
			confidence: CONFIDENCE
		},
		required: ['page_type', 'description', 'confidence'],
		additionalProperties: false
	};
	const prompt =
		'This is a screenshot of a web page, captured for a library of website design references.\n' +
		`URL: ${screen.url}\nTitle: ${screen.title}\n\n` +
		'Classify the page by what it is for, not by what site it belongs to. ' +
		`Allowed page types: ${PAGE_TYPES.join(', ')}. ` +
		"Use 'other' only when none fits. Describe what the page shows and how it is laid out " +
		`in one or two sentences. ${CONFIDENCE_PROMPT}`;
	const answer = await chat(
		endpoint,
		[
			{
				role: 'user',
				content: [
					{ type: 'image_url', image_url: { url: uri } },
					{ type: 'text', text: prompt }
				]
			}
		],
		{ schema: { name: 'screen_classification', schema }, maxTokens: CLASSIFICATION_MAX_TOKENS }
	);
	const parsed = JSON.parse(answer) as { page_type: string; description: string };
	return { pageType: parsed.page_type, description: parsed.description };
}

/** Which of the kind's fixed labels describes a cropped element best. */
export async function labelElement(
	endpoint: ModelEndpoint,
	crop: { image: Uint8Array; kind: ElementKind }
): Promise<string> {
	const labels = ELEMENT_LABELS[crop.kind];
	const { uri } = await imageDataUri(crop.image, ELEMENT_MAX_SIDE);
	const schema = {
		type: 'object',
		properties: { label: { type: 'string', enum: labels }, confidence: CONFIDENCE },
		required: ['label', 'confidence'],
		additionalProperties: false
	};
	const prompt =
		`This is a cropped UI element of kind '${crop.kind}' from a website. ` +
		`Which of these labels describes it best: ${labels.join(', ')}? ` +
		`Use 'other' only when none fits. ${CONFIDENCE_PROMPT}`;
	const answer = await chat(
		endpoint,
		[
			{
				role: 'user',
				content: [
					{ type: 'image_url', image_url: { url: uri } },
					{ type: 'text', text: prompt }
				]
			}
		],
		{ schema: { name: 'element_label', schema }, maxTokens: ELEMENT_LABEL_MAX_TOKENS }
	);
	return (JSON.parse(answer) as { label: string }).label;
}

/**
 * Names a flow from its screenshots: a category, a title and one caption per step. Only the first
 * `MAX_FLOW_STEPS` steps are looked at, so `captions` can be shorter than the flow the caller
 * holds. With `knownCategory` the category is not up to the model, as for flows that were planned
 * with one.
 */
export async function nameFlow(
	endpoint: ModelEndpoint,
	steps: { image: Uint8Array; url: string; actionLabel?: string }[],
	knownCategory?: FlowCategory
): Promise<{ category: string; title: string; captions: string[] }> {
	const shownSteps = steps.slice(0, MAX_FLOW_STEPS);
	const content: (
		{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
	)[] = [
		{
			type: 'text',
			text:
				"These screenshots are consecutive steps of one visitor's path through a website, " +
				'captured for a library of design references. Each step names its URL and the click ' +
				'that led to it.\n'
		}
	];
	for (const [index, step] of shownSteps.entries()) {
		const { uri } = await imageDataUri(step.image, FLOW_MAX_SIDE);
		const actionLabel = (step.actionLabel ?? '').trim().slice(0, MAX_ACTION_LABEL_CHARACTERS);
		const reachedBy =
			actionLabel === '' ? 'the first page' : `reached by clicking "${actionLabel}"`;
		content.push({ type: 'text', text: `\nStep ${index + 1}: ${step.url} (${reachedBy})` });
		content.push({ type: 'image_url', image_url: { url: uri } });
	}

	const categories = knownCategory === undefined ? FLOW_CATEGORIES : [knownCategory];
	// Property order is decoding order: the captions come first, so the title and category are
	// chosen after the model has described every step, and the array length is pinned to the
	// screenshots that were sent.
	const schema = {
		type: 'object',
		properties: {
			captions: {
				type: 'array',
				items: { type: 'string', maxLength: 200 },
				minItems: shownSteps.length,
				maxItems: shownSteps.length
			},
			title: { type: 'string', maxLength: 80 },
			category: { type: 'string', enum: categories },
			confidence: CONFIDENCE
		},
		required: ['captions', 'title', 'category', 'confidence'],
		additionalProperties: false
	};
	const categoryLines = categories
		.map((category) => `- ${category}: ${FLOW_CATEGORY_DESCRIPTIONS[category]}`)
		.join('\n');
	content.push({
		type: 'text',
		text:
			'\n\nName this flow. captions: one sentence per step, in order, saying what the ' +
			'screenshot shows and what the visitor did to get there (for the first step, what the ' +
			"visitor starts on). title: a short free-text name for the whole flow, like 'Contacting " +
			"sales' or 'Browsing customer stories', without the site's name. category: what the " +
			'visitor is trying to do, judged by what the screenshots show and not by the first ' +
			`page alone. Allowed categories:\n${categoryLines}\nUse 'other' only when none fits. ` +
			'confidence: a number from 0 to 1.'
	});
	const answer = await chat(endpoint, [{ role: 'user', content }], {
		schema: { name: 'flow_naming', schema },
		maxTokens: FLOW_TOKENS_PER_STEP * shownSteps.length + FLOW_TITLE_AND_CATEGORY_TOKENS
	});
	return JSON.parse(answer) as { category: string; title: string; captions: string[] };
}
