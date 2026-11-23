// The models, reached over the OpenAI-compatible API that vLLM and llama.cpp's llama-server both
// speak. Shared by the app (embedding search queries) and the crawler (everything else). Where the
// models run, a RunPod endpoint or a local server, is only configuration; the prompts live next to
// the code that sends them.
import sharp from 'sharp';

/** One OpenAI-compatible server and the model name it serves. */
export interface ModelEndpoint {
	/** Base URL including `/v1`, e.g. `http://127.0.0.1:8020/v1`. */
	url: string;
	model: string;
	/** Bearer token, needed by RunPod's serverless endpoints and absent for local servers. */
	apiKey?: string;
	/**
	 * The provider OpenRouter must route to, by its slug like `streamlake`, and optionally the
	 * quantization it must serve, like `fp8`. Providers of one model differ: Phala serves GLM-5.3
	 * Flash too, claims JSON schema support and ignores the schema.
	 */
	upstream?: { provider: string; quantization?: string };
}

/**
 * Reads a model name in OpenRouter's `model@provider/quantization` notation, as its model pages
 * show it, like `z-ai/glm-5.3-flash@streamlake/fp8`. Both parts after the model are optional.
 */
function endpointModel(spec: string): Pick<ModelEndpoint, 'model' | 'upstream'> {
	const [model, upstreamText] = spec.split('@');
	if (upstreamText === undefined || upstreamText === '') return { model };
	const [provider, quantization] = upstreamText.split('/');
	return { model, upstream: { provider, quantization: quantization || undefined } };
}

export interface ModelConfig {
	/** Decides: classifies screens, names flows, plans flows and drives the browser. */
	vlm: ModelEndpoint;
	/** Points at elements. The same server as `vlm` unless a separate grounding model runs. */
	grounding: ModelEndpoint;
	/**
	 * Embeds screens, elements and search queries. Undefined when `REFS_EMBEDDING_URL` is not set:
	 * no embedder runs for now, so nothing is embedded and semantic search is off.
	 */
	embedding?: ModelEndpoint;
	/**
	 * Drives the browser by choosing one of the page's controls, such as Perplexity's
	 * pplx-decider on OpenRouter's System One endpoint. Undefined when `REFS_DECIDER_MODEL` is not
	 * set, and then the VLM drives the browser and the grounding model points at what it chose.
	 */
	decider?: ModelEndpoint;
}

/** How long a reasoning model may think, in OpenRouter's terms. */
export type Reasoning = 'none' | 'minimal' | 'low' | 'medium' | 'high';
const REASONING_LEVELS: Reasoning[] = ['none', 'minimal', 'low', 'medium', 'high'];

/**
 * Reads a reasoning level from the environment, or undefined when it is not set. A typo fails at
 * start rather than silently running the model without reasoning.
 */
export function reasoningFromEnv(name: string, value: string | undefined): Reasoning | undefined {
	if (value === undefined || value === '') return undefined;
	if (!REASONING_LEVELS.includes(value as Reasoning)) {
		throw new Error(`${name} must be one of ${REASONING_LEVELS.join(', ')}, not "${value}"`);
	}
	return value as Reasoning;
}

/**
 * Reads where the models live, like `configFromEnv` does for the database, so the crawler can pass
 * `process.env` and the app its own env. The VLM defaults to the local server `ml/` starts.
 */
export function modelConfigFromEnv(env: Record<string, string | undefined>): ModelConfig {
	const apiKey = env.REFS_MODEL_API_KEY || undefined;
	const vlm = {
		url: env.REFS_VLM_URL ?? 'http://127.0.0.1:8020/v1',
		...endpointModel(env.REFS_VLM_MODEL ?? 'vlm'),
		apiKey
	};
	return {
		vlm,
		grounding: {
			url: env.REFS_GROUNDING_URL ?? vlm.url,
			...(env.REFS_GROUNDING_MODEL === undefined
				? { model: vlm.model, upstream: vlm.upstream }
				: endpointModel(env.REFS_GROUNDING_MODEL)),
			apiKey
		},
		embedding:
			env.REFS_EMBEDDING_URL === undefined || env.REFS_EMBEDDING_URL === ''
				? undefined
				: { url: env.REFS_EMBEDDING_URL, model: env.REFS_EMBEDDING_MODEL ?? 'embedder', apiKey },
		decider:
			env.REFS_DECIDER_MODEL === undefined || env.REFS_DECIDER_MODEL === ''
				? undefined
				: {
						url: env.REFS_DECIDER_URL ?? 'https://openrouter.ai/api/v1',
						model: env.REFS_DECIDER_MODEL,
						apiKey
					}
	};
}

/**
 * A serverless worker that has scaled to zero starts vLLM and loads a 27B model before it answers,
 * which can take a minute or two; a request that is still waiting long after that is stuck.
 */
const REQUEST_TIMEOUT_MS = 10 * 60_000;

/** The server answered, but not with a usable answer: an error status, or output cut off. */
export class ModelError extends Error {}

async function post(endpoint: ModelEndpoint, path: string, body: object): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`${endpoint.url}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(endpoint.apiKey === undefined ? {} : { authorization: `Bearer ${endpoint.apiKey}` })
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		// fetch only rejects when no response arrived at all: the server is down or not listening.
		throw new Error(
			`The model server at ${endpoint.url} is not reachable (${(error as Error).message}). ` +
				'Set REFS_VLM_URL, or start the local servers with "cd ml && uv run serve".',
			{ cause: error }
		);
	}
	if (!response.ok) {
		throw new ModelError(
			`${endpoint.url}${path} answered ${response.status}: ${await response.text()}`
		);
	}
	return response.json();
}

export type ChatContent =
	{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | ChatContent[];
}

/**
 * Sends one chat completion and returns the text of the answer. With `schema` the server decodes
 * against it, so the answer always parses; `parseJson` on the result is then safe.
 */
export async function chat(
	endpoint: ModelEndpoint,
	messages: ChatMessage[],
	options: {
		schema?: { name: string; schema: object };
		maxTokens: number;
		/**
		 * Lets a Qwen model reason before answering. Off by default: classifying and pointing are
		 * perception tasks, and the reasoning tokens make them several times slower.
		 */
		thinking?: boolean;
		/**
		 * How long a hosted reasoning model thinks, sent the way OpenRouter takes it. `maxTokens`
		 * includes the reasoning. Minimal by default, like `thinking` is off: GLM-5.3 Flash reasons
		 * unless told otherwise and spent all 60 tokens of a short classification on it, answering
		 * nothing, and it refuses `none`. Servers that don't know the field ignore it.
		 */
		reasoning?: Reasoning;
	}
): Promise<string> {
	const body = {
		model: endpoint.model,
		messages,
		temperature: 0,
		max_tokens: options.maxTokens,
		chat_template_kwargs: { enable_thinking: options.thinking === true },
		reasoning: { effort: options.reasoning ?? 'minimal' },
		...(options.schema === undefined
			? {}
			: {
					response_format: {
						type: 'json_schema',
						json_schema: { name: options.schema.name, schema: options.schema.schema, strict: true }
					}
				}),
		// OpenRouter's routing; local servers ignore the field. With a schema only providers that
		// take one, and with a pinned upstream only that one.
		provider: {
			require_parameters: options.schema !== undefined,
			...(endpoint.upstream === undefined
				? {}
				: {
						order: [endpoint.upstream.provider],
						allow_fallbacks: false,
						...(endpoint.upstream.quantization === undefined
							? {}
							: { quantizations: [endpoint.upstream.quantization] })
					})
		}
	};
	const answer = (await post(endpoint, '/chat/completions', body)) as {
		choices: { finish_reason: string; message: { content: string | null } }[];
	};
	const choice = answer.choices[0];
	// A reasoning model that thinks until the limit has no answer at all, only a null content.
	const content = choice.message.content ?? '';
	if (choice.finish_reason === 'length') {
		throw new ModelError(
			`The model ran out of tokens before finishing its answer: ${content.slice(0, 1500)}`
		);
	}
	return content;
}

/**
 * Shrinks a screenshot to fit `maxSide` and returns it as a JPEG data URI, with the size of the
 * original. A 2880x1800 retina capture is about 5000 image tokens, which is slow and adds nothing
 * for judging a layout. Click points stay valid because models answer in fractions of the image.
 */
export async function imageDataUri(
	image: Buffer | Uint8Array,
	maxSide: number
): Promise<{ uri: string; width: number; height: number }> {
	const original = sharp(image);
	const { width, height } = await original.metadata();
	const jpeg = await original
		.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: 90 })
		.toBuffer();
	return { uri: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width, height };
}

/**
 * Embedding size stored in the database. Qwen3-VL-Embedding-2B outputs 2048 numbers and is trained
 * so that any prefix of at least 64 is still usable (Matryoshka representation learning); 1024 found
 * the same neighbours as 2048 on our screens (issue #7). Changing it means re-embedding everything.
 */
export const EMBEDDING_DIMENSIONS = 1024;
/** The model's default instruction. A task specific one gains 1 to 5 percent per its model card. */
const DEFAULT_EMBEDDING_INSTRUCTION = "Represent the user's input.";
/** Embedding input is shrunk like the other screenshots, so a retina capture doesn't cost 5000 tokens. */
const EMBEDDING_MAX_SIDE = 1280;

/** Embeds text, an image, or both together into one vector of unit length. */
export async function embed(
	endpoint: ModelEndpoint,
	input: { text?: string; image?: Buffer | Uint8Array; instruction?: string }
): Promise<number[]> {
	const content: ChatContent[] = [];
	if (input.image !== undefined) {
		const { uri } = await imageDataUri(input.image, EMBEDDING_MAX_SIDE);
		content.push({ type: 'image_url', image_url: { url: uri } });
	}
	if (input.text !== undefined) content.push({ type: 'text', text: input.text });
	const answer = (await post(endpoint, '/embeddings', {
		model: endpoint.model,
		messages: [
			{
				role: 'system',
				content: [{ type: 'text', text: input.instruction ?? DEFAULT_EMBEDDING_INSTRUCTION }]
			},
			{ role: 'user', content }
		],
		encoding_format: 'float'
	})) as { data: { embedding: number[] }[] };
	const vector = answer.data[0].embedding.slice(0, EMBEDDING_DIMENSIONS);
	// Cutting a prefix off a normalized vector leaves it shorter than 1, and cosine search in the
	// database expects unit vectors.
	const length = Math.hypot(...vector);
	return vector.map((value) => value / length);
}
