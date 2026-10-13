// The JSON the tools return. Every result has its id, a refs_url that opens it in the Refs UI, and an
// image_url for the full-resolution media. The image_url never expires because media keys are immutable.
import type { CallToolResult, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import sharp from 'sharp';
import { media } from '../db.ts';
import { normaliseUrl } from '../queries.ts';
import { mediaUrl } from '../media.ts';
import type { ElementRow, PageGroup, ScreenRow, SiteSummary } from './queries.ts';

/** A result's JSON, plus the media key of the image that shows it inline. */
export interface Result {
	json: Record<string, unknown>;
	imageKey?: string;
}

/** The app's slug for a host or URL, such as `stripe-com` for `www.stripe.com`. Undefined for input that isn't a site. */
export function siteSlugOf(hostOrUrl: string): string | undefined {
	return normaliseUrl(hostOrUrl)?.slug;
}

function siteUrl(origin: string, slug: string): string {
	return `${origin}/sites/${slug}`;
}

/**
 * Opens a screen in the viewer. The viewport has to be in the link, because the site page shows one
 * viewport at a time; `elementId` additionally highlights that element on the screen.
 */
function screenUrl(
	origin: string,
	site: string,
	viewport: string,
	screenId: string,
	elementId?: string
): string {
	const params = new URLSearchParams({ viewport, screen: screenId });
	if (elementId !== undefined) params.set('el', elementId);
	return `${siteUrl(origin, site)}?${params}`;
}

function imageUrl(origin: string, key: string): string {
	return `${origin}${mediaUrl(key)}`;
}

export function siteResult(
	origin: string,
	site: SiteSummary,
	imageKey: string | undefined
): Result {
	return {
		imageKey,
		json: {
			id: site.id,
			refs_url: siteUrl(origin, site.id),
			image_url: imageKey === undefined ? undefined : imageUrl(origin, imageKey),
			name: site.name,
			host: site.host,
			description: site.description,
			counts: site.counts
		}
	};
}

export function pageResult(origin: string, site: string, page: PageGroup): Result {
	return {
		imageKey: page.image,
		json: {
			id: page.id,
			refs_url: screenUrl(origin, site, page.viewport, page.id),
			image_url: imageUrl(origin, page.image),
			site,
			path: page.path,
			title: page.title,
			viewport: page.viewport,
			page_count: page.page_count,
			state_count: page.state_count
		}
	};
}

export function screenResult(origin: string, screen: ScreenRow, imageKey: string): Result {
	return {
		imageKey,
		json: {
			id: screen.id,
			refs_url: screenUrl(origin, screen.site, screen.viewport, screen.id),
			image_url: imageUrl(origin, imageKey),
			site: screen.site,
			url: screen.url,
			path: screen.path,
			title: screen.title,
			viewport: screen.viewport,
			kind: screen.kind,
			page_type: screen.page_type,
			description: screen.description
		}
	};
}

export function elementResult(origin: string, element: ElementRow): Result {
	return {
		imageKey: element.media,
		json: {
			id: element.id,
			refs_url: screenUrl(origin, element.site, element.viewport, element.screen, element.id),
			image_url: imageUrl(origin, element.media),
			site: element.site,
			screen: element.screen,
			kind: element.kind,
			name: element.name,
			label: element.label,
			viewport: element.viewport
		}
	};
}

/** A tool result with the inline previews first and one JSON text block after them. */
export function textResult(payload: unknown, previews: ImageContent[] = []): CallToolResult {
	return {
		content: [...previews, { type: 'text', text: JSON.stringify(payload) }]
	};
}

export function errorResult(message: string): CallToolResult {
	return { isError: true, content: [{ type: 'text', text: message }] };
}

// --- inline previews -------------------------------------------------------------------------
// The image block a client shows the model next to each result. Stored screenshots are large, so
// they are shrunk before they go over the wire.

// 768 CSS px is wide enough to read a page's layout and most of its text, and small enough that a
// preview costs far fewer tokens than the 1440 px originals.
const PREVIEW_WIDTH = 768;
// Quality 75 keeps UI text legible at this size while each preview stays around tens of kilobytes.
const PREVIEW_QUALITY = 75;

/**
 * One preview per media key, in order. A key that is missing from the media store gets no preview,
 * but its result still carries `image_url`, so the model can see the rest of the result.
 */
export async function previewBlocks(keys: (string | undefined)[]): Promise<ImageContent[]> {
	const blocks = await Promise.all(
		keys.map((key) => (key === undefined ? undefined : previewBlock(key)))
	);
	return blocks.filter((block): block is ImageContent => block !== undefined);
}

async function previewBlock(mediaKey: string): Promise<ImageContent | undefined> {
	const original = await media.get(mediaKey);
	if (original === undefined) return undefined;
	const jpeg = await sharp(original)
		// Element crops can be narrower than the preview width, and enlarging them adds nothing.
		.resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
		.jpeg({ quality: PREVIEW_QUALITY })
		.toBuffer();
	return { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' };
}
