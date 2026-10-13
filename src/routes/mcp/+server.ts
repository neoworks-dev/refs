// Streamable HTTP endpoint of the Refs MCP server. Every request needs an API key, made with `bun run api-key create`.
import { db } from '#lib/server/db.ts';
import { authenticateApiKey } from '#lib/server/mcp/keys.ts';
import { registerGetTool } from '#lib/server/mcp/get.ts';
import { registerSearchTool } from '#lib/server/mcp/search.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { RequestHandler } from './$types';

const BEARER_PREFIX = 'Bearer ';
// JSON-RPC's implementation-defined range; the code tells an MCP client that this is an auth failure.
const UNAUTHORIZED_CODE = -32001;

const serve: RequestHandler = async ({ request, url }) => {
	const presentedKey = bearerToken(request);
	const apiKey =
		presentedKey === undefined ? undefined : await authenticateApiKey(await db(), presentedKey);
	// Unknown, revoked and missing keys get the same answer, so a response doesn't reveal which it was.
	if (apiKey === undefined) return unauthorized();
	return handleMcpRequest(request, url.origin);
};

// Streamable HTTP uses POST for requests, GET for an optional server stream and DELETE to end a session.
// The server is stateless, so GET and DELETE are answered by the SDK without a session.
export const GET = serve;
export const POST = serve;
export const DELETE = serve;

function bearerToken(request: Request): string | undefined {
	const header = request.headers.get('authorization') ?? '';
	return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : undefined;
}

function unauthorized(): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: '2.0',
			error: { code: UNAUTHORIZED_CODE, message: 'Missing or invalid API key' },
			id: null
		}),
		{
			status: 401,
			headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }
		}
	);
}

// The server is stateless: no session survives a request, so any number of app instances can
// answer the same client.
/** Runs one Streamable HTTP request through a fresh server. `origin` is the app's origin, used to build links. */
async function handleMcpRequest(request: Request, origin: string): Promise<Response> {
	const server = new McpServer({ name: 'refs', version: '0.1.0' });
	registerSearchTool(server, origin);
	registerGetTool(server, origin);

	// The SDK refuses to reuse a stateless transport, so each request gets its own. Plain JSON
	// responses instead of an SSE stream, because each answer is complete and nothing is pushed later.
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await server.connect(transport);
	return transport.handleRequest(request);
}
