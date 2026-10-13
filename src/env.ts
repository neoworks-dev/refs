// Server-side environment variables, imported from `$app/env/private`. All are optional: the
// defaults in src/lib/server/surreal.ts and db.ts match .env.example for local development.
import { defineEnvVars } from '@sveltejs/kit/env';

const optional = (value: string | undefined) => value;

export const variables = defineEnvVars({
	SURREAL_URL: {
		schema: optional,
		description: 'SurrealDB RPC endpoint, e.g. ws://127.0.0.1:8010/rpc'
	},
	SURREAL_USER: { schema: optional },
	SURREAL_PASS: { schema: optional },
	SURREAL_NS: { schema: optional, description: 'SurrealDB namespace' },
	SURREAL_DB: { schema: optional, description: 'SurrealDB database' },
	MEDIA_DIR: { schema: optional, description: 'Directory screenshots and crops are stored in' }
});
