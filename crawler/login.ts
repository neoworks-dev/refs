// `bun run login <site>`: the demo account signed up or logged in by a person. Most products guard
// their sign-up with bot protection, and getting around it is not something the crawler does. A
// person signs up once, in a plain Chrome that nothing controls; only afterwards does the crawler
// connect to that Chrome to read the login. Crawls and requests then start signed in, and an
// expired login is renewed with the same password.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Surreal } from 'surrealdb';
import { loadAccount, saveLogin, startAccount } from './accounts.ts';
import { ensureSite } from './jobs.ts';
import { waitForVerificationMail } from './mail.ts';

/**
 * Chrome as people use it, looked for in this order on the PATH, or `REFS_LOGIN_CHROME`. Not
 * Playwright's Chromium: a browser under automation shows it, and sign-ups refused it even with a
 * person at the keyboard.
 */
const LOGIN_CHROME_NAMES = [
	'google-chrome-stable',
	'google-chrome',
	'chromium',
	'chromium-browser'
];

export async function manualLogin(
	db: Surreal,
	siteInput: string,
	signal: AbortSignal
): Promise<void> {
	const chromePath = process.env.REFS_LOGIN_CHROME || findOnPath(LOGIN_CHROME_NAMES);
	if (chromePath === undefined) {
		throw new Error(
			`No Chrome found (${LOGIN_CHROME_NAMES.join(', ')}). Set REFS_LOGIN_CHROME to its path.`
		);
	}
	const site = await ensureSite(db, siteInput);
	const siteId = String(site.id.id);
	const existing = await loadAccount(db, siteId);
	// A working account keeps its address, so its login is renewed rather than a second one made.
	const account =
		existing?.status === 'active' ? existing : await startAccount(db, siteId, existing);

	console.log(
		`${site.host}: sign up or log in with the demo account in the Chrome window that opens.`
	);
	console.log(`  email:    ${account.email}`);
	console.log(`  password: ${account.password}`);
	console.log('  Use the email and password only, no "Continue with Google" or similar.');

	// A fresh profile, so the login saved is the demo account's and nothing of anyone's own Chrome.
	const profile = await mkdtemp(join(tmpdir(), 'refs-login-'));
	const debuggingPort = await freePort();
	const chrome = spawn(
		chromePath,
		[
			`--user-data-dir=${profile}`,
			`--remote-debugging-port=${debuggingPort}`,
			'--no-first-run',
			'--no-default-browser-check',
			site.url
		],
		{ stdio: 'ignore' }
	);
	let chromeClosed = false;
	chrome.on('exit', () => {
		chromeClosed = true;
	});

	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	const stop = new AbortController();
	// In a terminal, readline takes Ctrl-C for itself instead of the process.
	terminal.on('SIGINT', () => stop.abort());
	signal.addEventListener('abort', () => stop.abort());
	try {
		// The verification email goes to the plus address in the shared inbox; its code or link is
		// printed here so nobody has to search the inbox for it.
		void waitForVerificationMail({
			address: account.email,
			since: new Date(),
			signal: stop.signal
		}).then(
			(mail) => {
				if (mail === undefined) return;
				console.log(`\nVerification email "${mail.subject}" arrived:`);
				if (mail.link !== undefined) console.log(`  link: ${mail.link}`);
				if (mail.code !== undefined) console.log(`  code: ${mail.code}`);
			},
			(error: Error) => {
				// The inbox only helps; when it can't be read, the email is still in Gmail.
				console.warn(`The inbox could not be read: ${error.message}`);
			}
		);

		await terminal.question('\nPress Enter once you are signed in. ', { signal: stop.signal });
		if (chromeClosed) {
			console.log('Chrome was closed before the login could be read, so nothing was saved.');
			return;
		}
		const storageState = await readStorageState(debuggingPort);
		await saveLogin(db, siteId, JSON.stringify(storageState));
		console.log(
			`Saved ${storageState.cookies.length} cookies and the local storage of ` +
				`${storageState.origins.length} origins. Crawls of ${site.host} now start signed in as ${account.email}.`
		);
	} catch (error) {
		// Ctrl-C at the prompt aborts the question, which means stop without saving.
		if (!(error instanceof Error && error.name === 'AbortError')) throw error;
		console.log('\nStopped, nothing was saved.');
	} finally {
		stop.abort();
		terminal.close();
		chrome.kill();
		await rm(profile, { recursive: true, force: true });
	}
}

/** Playwright's storage state, which `openContext` loads into the crawler's browser. */
interface StorageState {
	cookies: {
		name: string;
		value: string;
		domain: string;
		path: string;
		/** Seconds since the epoch, or -1 for a session cookie. */
		expires: number;
		httpOnly: boolean;
		secure: boolean;
		sameSite: 'Strict' | 'Lax' | 'None';
	}[];
	origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

/**
 * Reads the login of the running Chrome over its DevTools protocol: every cookie, and the local
 * storage of every open tab's origin, where single-page apps keep their tokens. This is done
 * directly instead of through Playwright, whose `connectOverCDP` never finishes its WebSocket
 * handshake when it runs under Bun.
 */
async function readStorageState(port: number): Promise<StorageState> {
	const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
		webSocketDebuggerUrl: string;
	};
	const { cookies } = (await devToolsCall(version.webSocketDebuggerUrl, 'Storage.getCookies')) as {
		cookies: {
			name: string;
			value: string;
			domain: string;
			path: string;
			expires: number;
			httpOnly: boolean;
			secure: boolean;
			session: boolean;
			sameSite?: 'Strict' | 'Lax' | 'None';
		}[];
	};

	const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
		type: string;
		url: string;
		webSocketDebuggerUrl: string;
	}[];
	const origins = new Map<string, { name: string; value: string }[]>();
	for (const target of targets) {
		if (target.type !== 'page' || !target.url.startsWith('http')) continue;
		const answer = (await devToolsCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
			expression: 'JSON.stringify([location.origin, Object.entries(localStorage)])',
			returnByValue: true
		})) as {
			result: { value?: string };
			exceptionDetails?: { exception?: { description?: string } };
		};
		if (answer.exceptionDetails !== undefined) {
			// A page that may not use storage (a sandboxed document, say) holds no login to save.
			console.warn(
				`The local storage of ${target.url} could not be read: ${answer.exceptionDetails.exception?.description}`
			);
			continue;
		}
		const [origin, entries] = JSON.parse(answer.result.value!) as [string, [string, string][]];
		origins.set(
			origin,
			entries.map(([name, value]) => ({ name, value }))
		);
	}

	return {
		cookies: cookies.map((cookie) => ({
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain,
			path: cookie.path,
			expires: cookie.session ? -1 : cookie.expires,
			httpOnly: cookie.httpOnly,
			secure: cookie.secure,
			// Chrome leaves it out for cookies that set none, and treats those as Lax.
			sameSite: cookie.sameSite ?? 'Lax'
		})),
		origins: [...origins].map(([origin, localStorage]) => ({ origin, localStorage }))
	};
}

/** One DevTools protocol command on its own connection, for the few this file needs. */
function devToolsCall(socketUrl: string, method: string, params: object = {}): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(socketUrl);
		socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }));
		socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as {
				id?: number;
				result?: unknown;
				error?: { message: string };
			};
			// Events the target sends on its own carry no id.
			if (message.id !== 1) return;
			socket.close();
			if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`));
			else resolve(message.result);
		};
		socket.onerror = () => reject(new Error(`${method}: the DevTools connection failed`));
	});
}

/** The first of these programs found in a directory of the PATH. */
function findOnPath(names: string[]): string | undefined {
	const directories = (process.env.PATH ?? '').split(delimiter);
	for (const name of names) {
		for (const directory of directories) {
			const candidate = join(directory, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/** A port nothing listens on, found by letting the system pick one and giving it back. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}
