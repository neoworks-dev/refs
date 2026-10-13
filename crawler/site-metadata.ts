// Fills in the site's name, description and icon from its start page.
import type { BrowserContext, Page } from 'playwright';
import sharp from 'sharp';
import { RecordId } from '#lib/server/surreal.ts';
import type { CrawlContext } from './crawl.ts';
import type { PageDetails } from './page.ts';
import { bareHost } from './rules.ts';

const MAX_NAME_LENGTH = 60;
const ICON_SIZE = 128;
const ICON_FETCH_TIMEOUT_MS = 10_000;
/** Splits "Brand | Tagline", "Brand – Tagline", "Brand: Tagline" and similar titles. */
const TITLE_SEPARATOR = /\s+[|–—·•-]\s+|:\s+/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * "Linear – Plan and build products" -> "Linear". With several parts, the one that contains the
 * host's name wins ("Pricing | Linear" -> "Linear"); otherwise the first part, which is the brand
 * on most home pages.
 */
export function cleanSiteName(title: string, host: string): string {
	const parts = title.split(TITLE_SEPARATOR).map((part) => part.trim()).filter(Boolean);
	if (parts.length === 0) return '';
	const brand = bareHost(host).split('.')[0].replaceAll('-', '').toLowerCase();
	const matching = parts.find((part) => part.toLowerCase().replaceAll(/[\s-]/g, '').includes(brand));
	return (matching ?? parts[0]).slice(0, MAX_NAME_LENGTH);
}

/** Largest declared size of an icon link ("180x180" -> 180); "any" (SVG) counts as huge. */
function declaredSize(sizes: string): number {
	if (sizes.toLowerCase() === 'any') return 1000;
	return Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/g)].map((match) => Number(match[1])));
}

/** Icon URLs to try, best first: touch icons, then other icons by size, then /favicon.ico. */
function iconCandidates(details: PageDetails, origin: string): string[] {
	const bySizeDescending = (first: PageDetails['icons'][number], second: PageDetails['icons'][number]) =>
		declaredSize(second.sizes) - declaredSize(first.sizes);
	const touchIcons = details.icons.filter((icon) => icon.rel.includes('apple-touch-icon')).sort(bySizeDescending);
	const otherIcons = details.icons.filter((icon) => !icon.rel.includes('apple-touch-icon')).sort(bySizeDescending);
	return [...touchIcons, ...otherIcons].map((icon) => icon.href).concat(`${origin}/favicon.ico`);
}

/** .ico files often embed a PNG; sharp can't read .ico itself, so pull the largest PNG out. */
function pngFromIco(data: Buffer): Buffer | undefined {
	const isIco = data.length > 6 && data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 1;
	if (!isIco) return undefined;
	const entryCount = data.readUInt16LE(4);
	let best: Buffer | undefined;
	for (let entry = 0; entry < entryCount; entry++) {
		const directoryOffset = 6 + entry * 16;
		const size = data.readUInt32LE(directoryOffset + 8);
		const offset = data.readUInt32LE(directoryOffset + 12);
		const image = data.subarray(offset, offset + size);
		if (image.subarray(0, 4).equals(PNG_SIGNATURE) && (!best || image.length > best.length)) best = image;
	}
	return best;
}

async function downloadIcon(context: BrowserContext, url: string): Promise<Buffer | undefined> {
	try {
		const response = await context.request.get(url, { timeout: ICON_FETCH_TIMEOUT_MS });
		if (!response.ok()) return undefined;
		const data = await response.body();
		const source = pngFromIco(data) ?? data;
		return await sharp(source)
			.resize(ICON_SIZE, ICON_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png()
			.toBuffer();
	} catch (error) {
		// Network failure, or something sharp can't read (HTML error page, BMP-based .ico). The icon
		// is optional, so say why and let the caller try the next candidate.
		console.warn(`  icon ${url} skipped: ${error instanceof Error ? error.message : error}`);
		return undefined;
	}
}

/** Reads the start page's metadata and fills in what the site record doesn't have yet. */
export async function applySiteMetadata(ctx: CrawlContext, page: Page): Promise<void> {
	const details = await page.evaluate(() => window.pageInspector!.pageDetails());
	const { site } = ctx;
	const updates: Record<string, string> = {};

	// Only replace values that are still the placeholder: a person may have renamed the site.
	if (!site.name || site.name === site.host) {
		const name = details.siteName || cleanSiteName(details.title, site.host);
		if (name) updates.name = name;
	}
	if (!site.description || site.description === site.host) {
		if (details.description) updates.description = details.description;
	}

	if (!site.icon) {
		const origin = new URL(page.url()).origin;
		for (const iconUrl of iconCandidates(details, origin)) {
			const icon = await downloadIcon(page.context(), iconUrl);
			if (!icon) continue;
			const key = `sites/${ctx.siteId}/icon.png`;
			await ctx.media.put(key, icon);
			updates.icon = key;
			break;
		}
	}

	if (Object.keys(updates).length > 0) {
		await ctx.db.query('UPDATE $id MERGE $updates', { id: site.id, updates }).collect();
		Object.assign(site, updates);
	}
}

/** Makes the start page the site's card preview for this viewport. */
export async function setCover(ctx: CrawlContext, screenId: string): Promise<void> {
	const field = ctx.job.viewport === 'desktop' ? 'cover.desktop' : 'cover.mobile';
	await ctx.db
		.query(`UPDATE $site SET ${field} = $screen`, {
			site: ctx.job.site,
			screen: new RecordId('screen', screenId)
		})
		.collect();
}
