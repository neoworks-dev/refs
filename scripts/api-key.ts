// Manages the API keys that authorise the MCP server at /mcp.
//
//   bun run api-key create <name>   prints a new key once; it can't be shown again
//   bun run api-key list            names, creation and last use, never the key hash
//   bun run api-key revoke <name>   refuses the key from now on
import { activeKeysNamed, createApiKey, listApiKeys, revokeApiKey } from '#lib/server/mcp/keys.ts';
import { configFromEnv, connect } from '#lib/server/surreal.ts';

const USAGE = `usage:
  bun run api-key create <name>
  bun run api-key list
  bun run api-key revoke <name>`;

const [command, name] = process.argv.slice(2);
if (command === undefined) fail(USAGE);

const database = await connect(configFromEnv(process.env));
try {
	await run(command, name);
} finally {
	await database.close();
}

async function run(subcommand: string, keyName: string | undefined): Promise<void> {
	if (subcommand === 'create') {
		requireName(subcommand, keyName);
		// Names identify a key for revoke, so two active keys can't share one.
		if ((await activeKeysNamed(database, keyName)).length > 0) {
			fail(`an active key named "${keyName}" already exists; revoke it first`);
		}
		const key = await createApiKey(database, keyName);
		console.log(`Created key "${keyName}". Copy it now, it can't be shown again:\n`);
		console.log(key);
		return;
	}

	if (subcommand === 'list') {
		const keys = await listApiKeys(database);
		if (keys.length === 0) console.log('No API keys.');
		else
			console.table(
				keys.map((key) => ({
					name: key.name,
					created_at: key.created_at,
					last_used_at: key.last_used_at ?? 'never',
					revoked_at: key.revoked_at ?? ''
				}))
			);
		return;
	}

	if (subcommand === 'revoke') {
		requireName(subcommand, keyName);
		const revoked = await revokeApiKey(database, keyName);
		if (revoked === 0) fail(`no active key named "${keyName}"`);
		console.log(`Revoked key "${keyName}".`);
		return;
	}

	fail(USAGE);
}

function requireName(subcommand: string, keyName: string | undefined): asserts keyName is string {
	if (keyName === undefined || keyName.trim() === '') {
		fail(
			`"${subcommand}" needs a name, for example: bun run api-key ${subcommand} "Moritz laptop"`
		);
	}
}

/** Prints the message and exits non-zero; a bad invocation is not a crash, so no stack trace. */
function fail(message: string): never {
	console.error(message);
	process.exit(1);
}
