// Rules about what the crawler may visit and click: URL normalisation and scoring, which links are
// worth following, what is never clicked, and robots.txt.

const TRACKING_PARAM = /^(utm_.*|gclid|fbclid|ref|mc_.*)$/i;

/** Links to files are downloads, not pages. */
const FILE_EXTENSION =
	/\.(pdf|zip|gz|tgz|tar|rar|7z|dmg|exe|msi|pkg|apk|deb|rpm|iso|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp3|mp4|m4a|mov|avi|webm|wav|ogg|mkv|css|js|mjs|json|xml|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|otf|eot|rss|atom|map)$/i;

/** Paths that would end a session or have side effects even on GET. */
const UNSAFE_PATH = /(^|\/)(log-?out|sign-?out|unsubscribe|delete|remove)(\/|$|\?)/i;

const INTERESTING_PATH =
	/(^|[/-])(pricing|plans?|signup|sign-up|register|login|signin|sign-in|about|features?|product|products|solutions?|customers?|contact|careers?|jobs|changelog|docs|blog|faq|security|enterprise|download|integrations?|templates?|showcase)([/-]|$)/;

/** `www.example.com` and `example.com` are the same site. */
export function bareHost(hostname: string): string {
	return hostname.toLowerCase().replace(/^www\./, '');
}

export function slugFromHost(host: string): string {
	return host.replaceAll('.', '-');
}

/** Parses user input; a missing scheme defaults to https. Returns undefined when unusable. */
export function parseInputUrl(raw: string): URL | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	if (!URL.canParse(withScheme)) return undefined;
	const url = new URL(withScheme);
	return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
}

/**
 * Canonical form of a URL: lowercase host, no hash, no trailing slash, tracking params dropped and
 * the remaining params sorted. Returns undefined for anything that isn't a crawlable http(s) URL.
 */
export function normalizeUrl(input: string | URL, base?: string | URL): string | undefined {
	if (!URL.canParse(input, base)) return undefined;
	const url = new URL(input, base);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
	url.hash = '';
	// Credentials are never useful and can leak into stored records.
	url.username = '';
	url.password = '';
	const keptParams = [...url.searchParams.entries()].filter(([name]) => !TRACKING_PARAM.test(name));
	keptParams.sort(([nameA, valueA], [nameB, valueB]) =>
		nameA === nameB ? valueA.localeCompare(valueB) : nameA.localeCompare(nameB)
	);
	url.search = '';
	for (const [name, value] of keptParams) url.searchParams.append(name, value);
	if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
	// The root path is written without a slash: `https://example.com`.
	return url.pathname === '/' ? url.origin + url.search : url.origin + url.pathname + url.search;
}

/** Identity used to detect that two URLs are the same page (ignores scheme and www.). */
export function urlKey(url: string): string {
	const parsed = new URL(url);
	return (
		bareHost(parsed.hostname) +
		(parsed.port ? `:${parsed.port}` : '') +
		parsed.pathname +
		parsed.search
	);
}

/**
 * Whether a URL belongs to the site. Subdomains count as part of it: many sites send visitors from
 * the bare domain to a subdomain (spotify.com goes to open.spotify.com), and docs or app subdomains
 * are part of the same product. The screen budget and template caps keep large subdomains in check.
 */
export function isSameSite(url: string, host: string): boolean {
	const urlHost = bareHost(new URL(url).hostname);
	return urlHost === host || urlHost.endsWith(`.${host}`);
}

/** Path + query, as stored in `screen.path`. */
export function displayPath(url: string): string {
	const parsed = new URL(url);
	return parsed.pathname + parsed.search;
}

/** Skips downloads and links with side effects. */
export function isCrawlable(url: string): boolean {
	const parsed = new URL(url);
	return !FILE_EXTENSION.test(parsed.pathname) && !UNSAFE_PATH.test(parsed.pathname);
}

/** Template shape of a path: first segment + segment count, so `/blog/a` and `/blog/b` match. */
export function pathShape(url: string): string {
	const segments = new URL(url).pathname.split('/').filter(Boolean);
	return `${segments[0]?.toLowerCase() ?? ''}/${segments.length}`;
}

export type LinkRegion = 'nav' | 'main' | 'footer' | 'other';

const REGION_SCORE: Record<LinkRegion, number> = { nav: 3, main: 1, footer: -1, other: 0 };

/** Higher scores are visited first. */
export function scoreLink(url: string, depth: number, region: LinkRegion): number {
	const parsed = new URL(url);
	const path = parsed.pathname.toLowerCase();
	const segments = path.split('/').filter(Boolean).length;
	let score = 10 + REGION_SCORE[region];
	if (INTERESTING_PATH.test(path)) score += 4;
	score -= depth * 3;
	// Long, deep paths are usually content pages (articles, tags, user pages).
	score -= Math.min(4, path.length / 25);
	score -= Math.max(0, segments - 1) * 0.5;
	if (parsed.search) score -= 1.5;
	return score;
}

// --- safety ---------------------------------------------------------------------------------
/**
 * Names of controls that destroy data or commit to something. The crawler only ever looks, so
 * anything matching this is never clicked, even if it looks like a harmless menu trigger.
 */
export const DESTRUCTIVE_PATTERN =
	/\b(delete|remove|log ?out|sign ?out|unsubscribe|pay|purchase|buy now|place order|checkout|confirm|submit|cancel subscription|close account)\b/i;

export function isDestructive(label: string): boolean {
	return DESTRUCTIVE_PATTERN.test(label);
}

interface RobotsRule {
	allow: boolean;
	pattern: RegExp;
	length: number;
}

/** Disallow/Allow rules of the `User-agent: *` group of a robots.txt. */
export class Robots {
	private constructor(private readonly rules: RobotsRule[]) {}

	static allowAll(): Robots {
		return new Robots([]);
	}

	static parse(text: string): Robots {
		const rules: RobotsRule[] = [];
		let groupApplies = false;
		// Consecutive User-agent lines share the rules that follow them.
		let inAgentLines = false;
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.replace(/#.*/, '').trim();
			const separator = line.indexOf(':');
			if (separator < 0) continue;
			const field = line.slice(0, separator).trim().toLowerCase();
			const value = line.slice(separator + 1).trim();
			if (field === 'user-agent') {
				if (!inAgentLines) groupApplies = false;
				inAgentLines = true;
				if (value === '*') groupApplies = true;
				continue;
			}
			inAgentLines = false;
			if (!groupApplies || (field !== 'disallow' && field !== 'allow') || !value) continue;
			rules.push({ allow: field === 'allow', pattern: robotsPattern(value), length: value.length });
		}
		return new Robots(rules);
	}

	/** Longest matching rule wins; Allow wins ties, as in the robots.txt spec. */
	isAllowed(pathAndQuery: string): boolean {
		let best: RobotsRule | undefined;
		for (const rule of this.rules) {
			if (!rule.pattern.test(pathAndQuery)) continue;
			if (!best || rule.length > best.length || (rule.length === best.length && rule.allow))
				best = rule;
		}
		return best === undefined || best.allow;
	}
}

/** robots.txt patterns support `*` wildcards and a `$` end anchor. */
function robotsPattern(value: string): RegExp {
	const escaped = value.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	// A trailing `$` is left unescaped on purpose: it anchors the end of the path in the regex too.
	return new RegExp('^' + escaped);
}

/** Fetches robots.txt once. A missing or unreachable file means everything is allowed. */
export async function fetchRobots(origin: string, userAgent: string): Promise<Robots> {
	try {
		const response = await fetch(`${origin}/robots.txt`, {
			headers: { 'user-agent': userAgent },
			signal: AbortSignal.timeout(8000)
		});
		if (!response.ok) return Robots.allowAll();
		return Robots.parse(await response.text());
	} catch (error) {
		// Network failure or timeout. robots.txt is advisory and optional, so crawl rather than give up.
		console.warn(
			`robots.txt unavailable (${error instanceof Error ? error.message : error}), assuming allowed`
		);
		return Robots.allowAll();
	}
}
