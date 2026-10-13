// App-side singletons. The crawler builds its own from process.env (see crawler/).
import * as env from '$app/env/private';
import type { Surreal } from 'surrealdb';
import { localMedia } from './media.ts';
import { configFromEnv, connect } from './surreal.ts';

// The promise rather than the connection is cached, so concurrent first requests share one connect.
let connection: Promise<Surreal> | undefined;

/** Shared connection, created on first use. */
export function db(): Promise<Surreal> {
	if (connection === undefined) {
		connection = connect(configFromEnv(env)).catch((error) => {
			// Forget the failed attempt so the next request retries instead of failing forever.
			connection = undefined;
			throw error;
		});
	}
	return connection;
}

export const media = localMedia(env.MEDIA_DIR ?? 'data/media');
