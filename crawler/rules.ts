// Rules about what the crawler may do: URL normalisation, what is never clicked, and what may be typed.
import type { FocusedField } from './page.ts';

const TRACKING_PARAM = /^(utm_.*|gclid|fbclid|ref|mc_.*)$/i;

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

export type LinkRegion = 'nav' | 'main' | 'footer' | 'other';

// --- safety ---------------------------------------------------------------------------------
/**
 * Names of controls that destroy data or commit to something. The crawler only ever looks, so
 * anything matching this is never clicked, even if it looks like a harmless menu trigger.
 */
export const DESTRUCTIVE_PATTERN =
	/\b(delete|remove|log ?out|sign ?out|unsubscribe|pay|purchase|buy now|place order|checkout|confirm|submit|cancel subscription|close account)\b/i;

/**
 * "Submit" and "Confirm" are how sign-up forms end ("Confirm password", "Confirm email"), so they
 * are only let through for a demo account, where the form being submitted is the point.
 */
const SIGN_UP_WORDS = /\b(confirm|submit)\b/gi;

export function isDestructive(label: string, options: { hasDemoAccount?: boolean } = {}): boolean {
	const checked = options.hasDemoAccount ? label.replace(SIGN_UP_WORDS, '') : label;
	return DESTRUCTIVE_PATTERN.test(checked);
}

/** Buttons that leave for another service to log in. Exploration only uses the demo email and password. */
const THIRD_PARTY_LOGIN =
	/\b(continue|sign ?in|sign ?up|log ?in|connect|register)\s+(with|using|via)\s+(google|github|gitlab|apple|microsoft|facebook|twitter|x|linkedin|slack|sso|saml|passkey|a passkey)\b|\b(single sign-on|sso)\b/i;

export function isThirdPartyLogin(label: string): boolean {
	return THIRD_PARTY_LOGIN.test(label);
}

/** Input types that only ever hold personal data. */
const PERSONAL_INPUT_TYPES = new Set(['email', 'password', 'tel']);

/** Tokens of the HTML `autocomplete` attribute that name a person, a contact detail or a payment. */
const PERSONAL_AUTOCOMPLETE =
	/^(name|honorific-.*|given-name|additional-name|family-name|nickname|username|email|new-password|current-password|one-time-code|organization|organization-title|street-address|address-.*|postal-code|country.*|tel.*|bday.*|cc-.*|transaction-.*)$/;

/** Words that mark a field as asking for personal data when its type and autocomplete don't say. */
const PERSONAL_FIELD_TEXT =
	/e-?mail|password|passwort|phone|mobile|\btel\b|first.?name|last.?name|full.?name|your.?name|user.?name|\bname\b|address|street|\bzip\b|postal|\bcity\b|card|cvc|cvv|expir|iban|company|organi[sz]ation|birth/i;

/** A field that looks for something on the site. Its words ("search by name") must not count as personal. */
const SEARCH_FIELD_TEXT = /search|filter|find|suche|query/i;

/**
 * Whether typing into this field would enter personal data: an email, password, name, phone
 * number, address or payment detail. Search and filter fields are fine, whatever words they use.
 */
export function isPersonalDataField(field: FocusedField): boolean {
	if (PERSONAL_INPUT_TYPES.has(field.type)) return true;
	const autocompleteTokens = field.autocomplete.toLowerCase().split(/\s+/);
	if (autocompleteTokens.some((token) => PERSONAL_AUTOCOMPLETE.test(token))) return true;
	if (field.type === 'search' || SEARCH_FIELD_TEXT.test(field.text)) return false;
	return PERSONAL_FIELD_TEXT.test(field.text);
}

/** Text that is itself personal data, like an email address or a phone number the model made up. */
export function looksLikePersonalData(text: string): boolean {
	return /\S+@\S+\.\S+/.test(text) || /\+?\d[\d\s().-]{7,}\d/.test(text);
}

// --- the demo identity ----------------------------------------------------------------------
// With a demo account the crawler may type three things that are personal data in any other
// run: the account's email address, its password, and a made-up name. Anything else that is
// personal still is not: payment details, phone numbers, postal addresses, other email addresses.

/** The identity the model signs up and logs in with on one site. */
export interface DemoIdentity {
	email: string;
	password: string;
	/** A made-up name for forms that ask for one; the model may use another made-up name too. */
	name: string;
}

/** Tokens of the `autocomplete` attribute for payment, phone and postal data, which are never typed. */
const PAYMENT_OR_PHONE_AUTOCOMPLETE =
	/^(cc-.*|transaction-.*|tel.*|street-address|address-.*|postal-code|country.*|bday.*)$/;

/**
 * Words of fields that ask for payment, phone, postal, birth or tax data. "E-mail address" is
 * not one of them, which is why the phrase is taken out before the words are looked for.
 */
const PAYMENT_OR_PHONE_TEXT =
	/phone|mobile|\btel\b|address|street|\bzip\b|postal|\bcity\b|card|cvc|cvv|expir|iban|birth|\bssn\b|social security|tax.?id/i;

const PASSWORD_AUTOCOMPLETE = /^(new-password|current-password)$/;

/** Whether the text is the demo identity, as typed into a sign-up or login form. */
export function isDemoIdentityText(text: string, identity: DemoIdentity | undefined): boolean {
	return identity !== undefined && (text === identity.email || text === identity.password);
}

/**
 * Why typing `text` is refused before the field is even clicked, or undefined. Text that is itself
 * personal data (an email, a phone number) is only allowed when it is the demo identity.
 */
export function typedTextRefusal(
	text: string,
	identity: DemoIdentity | undefined
): string | undefined {
	if (isDemoIdentityText(text, identity) || !looksLikePersonalData(text)) return undefined;
	return `the model wanted to type "${text}", which is personal data`;
}

/**
 * Why typing `text` into the focused field is refused, or undefined. Without a demo identity every
 * personal field is refused. With one, only payment, phone and postal fields are, and the
 * password may only go into a password field.
 */
export function typedFieldRefusal(
	field: FocusedField,
	text: string,
	identity: DemoIdentity | undefined
): string | undefined {
	if (identity === undefined) {
		return isPersonalDataField(field)
			? `asks for personal data (${field.type} field "${field.text}")`
			: undefined;
	}
	const autocompleteTokens = field.autocomplete.toLowerCase().split(/\s+/);
	const fieldWords = field.text.replace(/e-?mail address/gi, 'email');
	if (
		field.type === 'tel' ||
		autocompleteTokens.some((token) => PAYMENT_OR_PHONE_AUTOCOMPLETE.test(token)) ||
		(!SEARCH_FIELD_TEXT.test(field.text) && PAYMENT_OR_PHONE_TEXT.test(fieldWords))
	) {
		return `asks for payment, phone or postal details (${field.type} field "${field.text}")`;
	}
	const isPasswordField =
		field.type === 'password' ||
		autocompleteTokens.some((token) => PASSWORD_AUTOCOMPLETE.test(token)) ||
		/password|passwort/i.test(field.text);
	if (isPasswordField && text !== identity.password) {
		return `only takes the demo account's password (${field.type} field "${field.text}")`;
	}
	if (!isPasswordField && text === identity.password) {
		return `is not a password field, and the demo password only goes into those (${field.type} field "${field.text}")`;
	}
	return undefined;
}
