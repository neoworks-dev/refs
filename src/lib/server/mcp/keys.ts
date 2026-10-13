// API keys for the MCP server. The full key is printed once when it is created. The database only
// keeps its SHA-256, so a lost key can be revoked and replaced but never recovered.
import { createHash, randomBytes } from 'node:crypto';
import type { Surreal } from 'surrealdb';
import type { ApiKey } from '../../types.ts';
import { plain } from '../surreal.ts';

export const KEY_PREFIX = 'refs_';
const KEY_RANDOM_LENGTH = 32;
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// 248 is the largest multiple of 62 below 256. Bytes at or above it are skipped, so every base62
// character is equally likely; a plain modulo would favour the first 8 characters.
const UNBIASED_BYTE_LIMIT = 248;

/** A new random key such as `refs_` plus 32 base62 characters, drawn from the OS CSPRNG. */
export function generateApiKey(): string {
	let random = '';
	while (random.length < KEY_RANDOM_LENGTH) {
		for (const byte of randomBytes(KEY_RANDOM_LENGTH)) {
			if (byte < UNBIASED_BYTE_LIMIT && random.length < KEY_RANDOM_LENGTH) {
				random += BASE62[byte % BASE62.length];
			}
		}
	}
	return KEY_PREFIX + random;
}

/** Hex SHA-256 of the full key, the only form of the key that is stored. */
export function hashApiKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

/** Stores a new key under `name` and returns the plain key. The caller must show it to the user now. */
export async function createApiKey(database: Surreal, name: string): Promise<string> {
	const key = generateApiKey();
	await database
		.query('CREATE api_key CONTENT { name: $name, hash: $hash }', {
			name,
			hash: hashApiKey(key)
		})
		.collect();
	return key;
}

/** Active (not revoked) keys with this name. Names are kept unique among active keys by the script. */
export async function activeKeysNamed(database: Surreal, name: string): Promise<ApiKey[]> {
	const [result] = await database
		.query('SELECT * FROM api_key WHERE name = $name AND revoked_at IS NONE', { name })
		.collect<[ApiKey[]]>();
	return plain<ApiKey[]>(result);
}

/** Every key, oldest first. The hash is left out so listings never expose it. */
export async function listApiKeys(
	database: Surreal
): Promise<Pick<ApiKey, 'name' | 'created_at' | 'last_used_at' | 'revoked_at'>[]> {
	const [result] = await database
		.query('SELECT name, created_at, last_used_at, revoked_at FROM api_key ORDER BY created_at')
		.collect<[ApiKey[]]>();
	return plain(result);
}

/** Marks the active keys with this name as revoked. Returns how many were revoked. */
export async function revokeApiKey(database: Surreal, name: string): Promise<number> {
	const [result] = await database
		.query(
			'UPDATE api_key SET revoked_at = time::now() WHERE name = $name AND revoked_at IS NONE RETURN AFTER',
			{ name }
		)
		.collect<[ApiKey[]]>();
	return result.length;
}

/**
 * The key record for a presented key, or undefined when the key is unknown or revoked. A
 * successful check also stamps `last_used_at`, in the same statement as the lookup.
 */
export async function authenticateApiKey(
	database: Surreal,
	presentedKey: string
): Promise<ApiKey | undefined> {
	const [result] = await database
		.query(
			'UPDATE api_key SET last_used_at = time::now() WHERE hash = $hash AND revoked_at IS NONE RETURN AFTER',
			{ hash: hashApiKey(presentedKey) }
		)
		.collect<[ApiKey[]]>();
	const [key] = plain<ApiKey[]>(result);
	return key;
}
