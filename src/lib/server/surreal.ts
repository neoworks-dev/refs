// SurrealDB connection shared by the SvelteKit app and the crawler worker. Takes its config as an
// argument so it has no dependency on `$env` (the crawler runs outside of SvelteKit).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime, RecordId, Surreal } from 'surrealdb';

export interface SurrealConfig {
	url: string;
	username: string;
	password: string;
	namespace: string;
	database: string;
}

export function configFromEnv(env: Record<string, string | undefined>): SurrealConfig {
	return {
		url: env.SURREAL_URL ?? 'ws://127.0.0.1:8010/rpc',
		username: env.SURREAL_USER ?? 'root',
		password: env.SURREAL_PASS ?? 'root',
		namespace: env.SURREAL_NS ?? 'refs',
		database: env.SURREAL_DB ?? 'main'
	};
}

// Both the app and the crawler run from the repo root.
const SCHEMA = join(process.cwd(), 'db/schema.surql');

/** Connects, selects namespace/database and applies `db/schema.surql`. */
export async function connect(config: SurrealConfig): Promise<Surreal> {
	const db = new Surreal();
	await db.connect(config.url, {
		namespace: config.namespace,
		database: config.database,
		authentication: { username: config.username, password: config.password }
	});
	await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${config.namespace}`).collect();
	await db.query(`DEFINE DATABASE IF NOT EXISTS ${config.database}`).collect();
	await db.use({ namespace: config.namespace, database: config.database });
	await db.query(await readFile(SCHEMA, 'utf8')).collect();
	return db;
}

/**
 * Converts SurrealDB values into plain JSON so they can cross the SvelteKit server/client
 * boundary: a RecordId becomes the string of its id part (`site:abc` -> `"abc"`), a DateTime
 * becomes an ISO string.
 */
export function plain<T = unknown>(value: unknown): T {
	return toPlain(value) as T;
}

function toPlain(value: unknown): unknown {
	if (value instanceof RecordId) return String(value.id);
	if (value instanceof DateTime) return value.toISOString();
	if (Array.isArray(value)) return value.map(toPlain);
	// Only plain objects are walked; other class instances (Uint8Array, …) pass through as they are.
	if (value && typeof value === 'object' && value.constructor === Object) {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) result[key] = toPlain(entry);
		return result;
	}
	return value;
}

export { RecordId };
