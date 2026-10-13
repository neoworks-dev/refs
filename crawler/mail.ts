// The demo inbox: plus addresses for the sites, and reading the mail a sign-up causes. Every site
// gets its own address (`name+<site>@gmail.com`), so one Gmail account receives everything and the
// address says which site a mail belongs to. The mailbox login comes from `REFS_MAIL_ADDRESS` and
// `REFS_MAIL_APP_PASSWORD` (a Gmail app password), and goes to Gmail's IMAP server and nowhere else.
import { once } from 'node:events';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;

/**
 * Mail counts as caused by the sign-up when it arrived at most this long before the sign-up began.
 * IMAP dates are the mail server's clock and the sign-up start is ours, so a mail that really
 * followed the sign-up can look a few seconds older. The plus address is unique to the account, so a
 * generous slack cannot pick up another site's mail.
 */
const CLOCK_SKEW_SLACK_MS = 60_000;

/** Verification mails that nobody reads for this long are not coming, or went to spam. */
export const DEFAULT_MAIL_DEADLINE_MS = 4 * 60_000;

/** Whether the demo inbox is set up. Without it exploration runs as a visitor, without accounts. */
export function mailIsConfigured(): boolean {
	return Boolean(process.env.REFS_MAIL_ADDRESS && process.env.REFS_MAIL_APP_PASSWORD);
}

export function mailSettings(): { address: string; appPassword: string } {
	const address = process.env.REFS_MAIL_ADDRESS;
	const appPassword = process.env.REFS_MAIL_APP_PASSWORD;
	if (!address || !appPassword) {
		throw new Error(
			'Set REFS_MAIL_ADDRESS and REFS_MAIL_APP_PASSWORD in .env to sign up to sites.'
		);
	}
	return { address, appPassword };
}

/** `name@gmail.com` and `linear-app` give `name+linear-app@gmail.com`; Gmail delivers it to `name@gmail.com`. */
export function plusAddress(base: string, tag: string): string {
	const [local, domain] = base.split('@');
	return `${local}+${tag}@${domain}`;
}

// --- finding the verification in a mail ----------------------------------------------------------

export interface VerificationMail {
	subject: string;
	/** The link to open, when the mail has one that looks like a verification or sign-in link. */
	link?: string;
	/** A one-time code, when the mail has one. */
	code?: string;
}

/** Words in a link's text or address that mark it as the one the mail is about. */
const VERIFICATION_LINK_WORDS =
	/verif|confirm|activat|magic|sign.?in|log.?in|validate|auth|token|complete|continue/i;
/** Links in every mail that are never the verification: footers, images and other protocols. */
const UNWANTED_LINK =
	/unsubscribe|privacy|terms|preferences|manage.?(email|notification)|\.(png|jpe?g|gif|svg|webp)(\?|$)|^(mailto|tel):/i;
/** A subject or text like this says the mail is about getting into the account. */
const VERIFICATION_MAIL_WORDS =
	/verif|confirm|activat|sign.?in|log.?in|magic|welcome|code|one-time/i;

/** The links of a mail, from the anchors of its HTML and the plain addresses of its text. */
function mailLinks(html: string, text: string): { url: string; label: string }[] {
	const links: { url: string; label: string }[] = [];
	for (const anchor of html.matchAll(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
		const url = anchor[1].replaceAll('&amp;', '&');
		const label = anchor[2]
			.replace(/<[^>]*>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		links.push({ url, label });
	}
	for (const address of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
		links.push({ url: address[0], label: '' });
	}
	return links.filter(
		(link) => /^https?:/i.test(link.url) && !UNWANTED_LINK.test(link.url + ' ' + link.label)
	);
}

/** A one-time code in the subject or the text, or undefined. */
function mailCode(subject: string, text: string): string | undefined {
	// "123456 is your verification code" in the subject. Any number in a subject is only a code
	// when the subject is about verification ("3 new comments" is not).
	const inSubject = VERIFICATION_MAIL_WORDS.test(subject) ? subject.match(/\b(\d{4,8})\b/) : null;
	// "Your code: 123456", "code is ABC123". The lookahead keeps plain words out of alphanumeric codes.
	const afterWord = text.match(
		/(?:code|otp|passcode|pin)\b[^A-Za-z0-9]{0,30}?((?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,10}|\d{3}[ -]\d{3})\b/i
	);
	// A code on a line of its own, as most mails show it.
	const alone = text.match(/^\s*(\d{4,8})\s*$/m);
	const match = inSubject ?? afterWord ?? alone;
	return match?.[1].replace(/[ -]/g, '');
}

/**
 * What a mail asks the visitor to do to get in: a link, preferring the ones whose text or address
 * says verify, confirm, activate, magic link or sign in, and a one-time code. Returns undefined for
 * a mail about something else, like a newsletter that arrived on the same address.
 */
export function findVerification(mail: {
	subject: string;
	html: string;
	text: string;
}): VerificationMail | undefined {
	const links = mailLinks(mail.html, mail.text);
	const labelled = links.find((link) => VERIFICATION_LINK_WORDS.test(link.label));
	const addressed = links.find((link) => VERIFICATION_LINK_WORDS.test(link.url));
	// A bare "click here" link is only trusted when the mail itself is about verification.
	const aboutVerification = VERIFICATION_MAIL_WORDS.test(mail.subject);
	const link = labelled ?? addressed ?? (aboutVerification ? links[0] : undefined);
	const code = mailCode(mail.subject, mail.text);
	if (link === undefined && code === undefined) return undefined;
	return { subject: mail.subject, link: link?.url, code };
}

// --- waiting for it ------------------------------------------------------------------------------

/** Whether a parsed mail was sent to exactly this address, not to another plus address of the inbox. */
export function isAddressedTo(mail: ParsedMail, address: string): boolean {
	const wanted = address.toLowerCase();
	const recipients = [mail.to, mail.cc].flatMap((field) =>
		field === undefined ? [] : Array.isArray(field) ? field : [field]
	);
	const fromHeaders = recipients.flatMap((field) =>
		field.value.map((entry) => entry.address ?? '')
	);
	// Gmail records the address a mail was delivered to, which is right even when the sender used Bcc.
	const delivered = mail.headers.get('delivered-to');
	const deliveredTo = (Array.isArray(delivered) ? delivered : [delivered]).map(String);
	return [...fromHeaders, ...deliveredTo].some((entry) => entry.toLowerCase() === wanted);
}

/**
 * Waits for the verification mail that a sign-up with `address` causes. Only mail to exactly that
 * plus address that arrived after `since` counts. It looks at the inbox now and again whenever the
 * server announces new mail (IMAP IDLE), until `deadlineMs` is over or `signal` aborts, and
 * returns undefined when nothing came.
 */
export async function waitForVerificationMail(options: {
	address: string;
	since: Date;
	deadlineMs?: number;
	signal?: AbortSignal;
}): Promise<VerificationMail | undefined> {
	const { address: inbox, appPassword } = mailSettings();
	const client = new ImapFlow({
		host: IMAP_HOST,
		port: IMAP_PORT,
		secure: true,
		auth: { user: inbox, pass: appPassword },
		logger: false
	});
	const stop = AbortSignal.any([
		AbortSignal.timeout(options.deadlineMs ?? DEFAULT_MAIL_DEADLINE_MS),
		...(options.signal === undefined ? [] : [options.signal])
	]);
	const searchSince = new Date(options.since.getTime() - CLOCK_SKEW_SLACK_MS);

	await client.connect();
	try {
		const lock = await client.getMailboxLock('INBOX');
		try {
			const examined = new Set<number>();
			// An aborted signal makes `once` throw at once under Bun, so a stop is checked before listening.
			while (!stop.aborted) {
				// Listening starts before the search, or a mail arriving in between would be missed.
				const listening = new AbortController();
				const arrival = once(client, 'exists', {
					signal: AbortSignal.any([listening.signal, stop])
				}).then(
					() => true,
					(error: Error) => {
						// Stopping the listener is how this wait ends: the deadline, a cancelled crawl, or a mail found.
						if (error.name === 'AbortError') return false;
						throw error;
					}
				);
				const found = await findInInbox(client, options.address, searchSince, examined);
				if (found !== undefined) {
					listening.abort();
					await arrival;
					return found;
				}
				if (!(await arrival)) return undefined;
			}
			return undefined;
		} finally {
			lock.release();
		}
	} finally {
		await client.logout();
	}
}

/** Reads the mail to `address` since `since` that was not examined yet, and returns the first verification among it. */
async function findInInbox(
	client: ImapFlow,
	address: string,
	since: Date,
	examined: Set<number>
): Promise<VerificationMail | undefined> {
	// IMAP can only search by day; the exact time is checked on the mail itself below.
	const matching = (await client.search({ to: address, since }, { uid: true })) || [];
	const fresh = matching.filter((uid) => !examined.has(uid));
	if (fresh.length === 0) return undefined;

	const candidates: { uid: number; arrived: Date; source: Buffer }[] = [];
	for await (const message of client.fetch(
		fresh,
		{ uid: true, internalDate: true, source: true },
		{ uid: true }
	)) {
		candidates.push({
			uid: message.uid,
			arrived: new Date(message.internalDate as Date | string),
			source: message.source as Buffer
		});
	}
	// The newest mail first: a re-sent verification supersedes the one before it.
	candidates.sort((first, second) => second.arrived.getTime() - first.arrived.getTime());
	for (const candidate of candidates) {
		examined.add(candidate.uid);
		if (candidate.arrived < since) continue;
		const parsed = await simpleParser(candidate.source);
		if (!isAddressedTo(parsed, address)) continue;
		const verification = findVerification({
			subject: parsed.subject ?? '',
			html: typeof parsed.html === 'string' ? parsed.html : '',
			text: parsed.text ?? ''
		});
		if (verification !== undefined) return verification;
	}
	return undefined;
}
