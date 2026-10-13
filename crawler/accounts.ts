// The demo account of a site: the record that holds its plus address, password and saved login,
// and the checks exploration needs around it (is the browser signed in, is the page waiting for
// a verification email). One account per site serves both viewports.
import { randomInt } from 'node:crypto';
import type { Page } from 'playwright';
import type { Surreal } from 'surrealdb';
import { plain, RecordId } from '#lib/server/surreal.ts';
import type { Account } from '#lib/types.ts';
import { mailSettings, plusAddress } from './mail.ts';
import type { AgentIdentity } from './agent.ts';

/** The name the model types where a sign-up asks for one; it may make up another that fits better. */
const DEMO_NAME = 'Alex Morgan';

const PASSWORD_LENGTH = 20;
/**
 * The classes a password rule may ask for. Symbols are a short list that sites accept: some forms
 * reject quotes, spaces and brackets, and a rejected password costs a whole sign-up attempt.
 */
const PASSWORD_CLASSES = [
	'abcdefghijkmnopqrstuvwxyz',
	'ABCDEFGHJKLMNPQRSTUVWXYZ',
	'23456789',
	'!@#$%&*'
];
/** Two of each class, so rules like "two digits" pass; the rest is drawn from all classes. */
const PASSWORD_CHARACTERS_PER_CLASS = 2;

/** A random password that passes common rules: long, with lower and upper case, digits and symbols. */
export function generatePassword(): string {
	const everything = PASSWORD_CLASSES.join('');
	const characters = PASSWORD_CLASSES.flatMap((characterClass) =>
		Array.from(
			{ length: PASSWORD_CHARACTERS_PER_CLASS },
			() => characterClass[randomInt(characterClass.length)]
		)
	);
	while (characters.length < PASSWORD_LENGTH)
		characters.push(everything[randomInt(everything.length)]);
	// Fisher-Yates, so the guaranteed characters are not always first.
	for (let i = characters.length - 1; i > 0; i--) {
		const swapWith = randomInt(i + 1);
		[characters[i], characters[swapWith]] = [characters[swapWith], characters[i]];
	}
	return characters.join('');
}

/**
 * The plus-address tag of the next attempt. The first account of a site is tagged with the site
 * (`linear-app`); after a refused one the tag gets a number (`linear-app-2`, `linear-app-3`), so
 * a site that remembers the refused address never sees it again.
 */
export function nextAccountTag(siteId: string, previousEmail: string | undefined): string {
	if (previousEmail === undefined) return siteId;
	const previousTag = previousEmail.split('@')[0].split('+')[1] ?? '';
	const attempt = previousTag.startsWith(`${siteId}-`)
		? Number(previousTag.slice(siteId.length + 1))
		: 1;
	return `${siteId}-${Number.isInteger(attempt) ? attempt + 1 : 2}`;
}

/** The account of a site, or undefined when none was ever started. */
export async function loadAccount(db: Surreal, siteId: string): Promise<Account | undefined> {
	const [accounts] = await db
		.query('SELECT * FROM $id', { id: new RecordId('account', siteId) })
		.collect<[unknown[]]>();
	return accounts.length === 0 ? undefined : plain<Account>(accounts[0]);
}

/**
 * Starts a sign-up: creates the site's account with a fresh plus address and password, or
 * replaces one that cannot be used any more (refused, or interrupted before it was confirmed).
 * The record is reused because the site has a unique index; the old address is never used again.
 */
export async function startAccount(
	db: Surreal,
	siteId: string,
	previous: Account | undefined
): Promise<Account> {
	const fields = {
		email: plusAddress(mailSettings().address, nextAccountTag(siteId, previous?.email)),
		password: generatePassword()
	};
	const id = new RecordId('account', siteId);
	if (previous === undefined) {
		await db
			.query(
				"CREATE ONLY $id CONTENT { site: $site, email: $email, password: $password, status: 'pending' }",
				{
					id,
					site: new RecordId('site', siteId),
					...fields
				}
			)
			.collect();
	} else {
		await db
			.query(
				"UPDATE $id SET email = $email, password = $password, status = 'pending', failure = NONE, storage_state = NONE, logged_in_at = NONE",
				{ id, ...fields }
			)
			.collect();
	}
	return (await loadAccount(db, siteId))!;
}

/** Marks the account as usable and keeps the browser's login (cookies and local storage) for later runs. */
export async function saveLogin(db: Surreal, siteId: string, storageState: string): Promise<void> {
	await db
		.query(
			"UPDATE $id SET status = 'active', failure = NONE, storage_state = $storageState, logged_in_at = time::now()",
			{ id: new RecordId('account', siteId), storageState }
		)
		.collect();
}

/** Marks the account as refused, so the next attempt uses another address. */
export async function failAccount(db: Surreal, siteId: string, failure: string): Promise<void> {
	await db
		.query("UPDATE $id SET status = 'failed', failure = $failure", {
			id: new RecordId('account', siteId),
			failure
		})
		.collect();
}

export function identityOf(account: Account): AgentIdentity {
	return { email: account.email, password: account.password, name: DEMO_NAME };
}

/** Names of the controls that a page shows to a visitor who is not signed in. */
const SIGNED_OUT_CONTROL =
	/^\s*(log ?in|sign ?in|sign ?up|register|join|create (an )?account)\s*$/i;

/**
 * Whether the page looks like it is shown to a signed-in user: no password field and no "Log in"
 * or "Sign up" control. It is a heuristic (a magic-link login form has neither), good enough to
 * notice that a saved login has expired, where a wrong guess only costs one more login attempt.
 */
export async function looksSignedIn(page: Page): Promise<boolean> {
	const signedOutSigns = [
		page.locator('input[type="password"]'),
		page.getByRole('link', { name: SIGNED_OUT_CONTROL }),
		page.getByRole('button', { name: SIGNED_OUT_CONTROL })
	];
	for (const sign of signedOutSigns) {
		if ((await sign.filter({ visible: true }).count()) > 0) return false;
	}
	return true;
}

/** Words of a page that waits for the visitor to confirm an email address. */
const VERIFICATION_PAGE =
	/verif|confirm your (e-?mail|account|address)|check your (e-?mail|inbox)|(we|we've|we have|i've) (just )?sent|sent (you |a |an )|enter the (\d|code)|one-time|magic link|activation/i;

export function pageAsksForVerification(pageText: string): boolean {
	return VERIFICATION_PAGE.test(pageText);
}
