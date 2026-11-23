// The model a benchmark runs, and the call it makes to it. Unlike the crawler's client
// (src/lib/server/models.ts), this one reports what every call cost, which is what the benchmarks
// are about, and speaks OpenRouter's extensions for that.

/** An OpenAI-compatible API and the environment variable its key is read from. */
interface Provider {
	url: string;
	apiKeyVariable: string;
	/**
	 * OpenRouter reports the cost of each call, can switch reasoning off for any model, and can be
	 * told to skip providers that would ignore the JSON schema. Other APIs get none of that.
	 */
	isOpenRouter: boolean;
}

const OPENROUTER: Provider = {
	url: 'https://openrouter.ai/api/v1',
	apiKeyVariable: 'OPENROUTER_API_KEY',
	isOpenRouter: true
};

const HCOMPANY: Provider = {
	url: 'https://api.hcompany.ai/v1',
	apiKeyVariable: 'HCOMPANY_API_KEY',
	isOpenRouter: false
};

/**
 * H Company's Holo models are not on OpenRouter, so they are named `hcompany/<model>` and priced
 * from this list, as published on 2026-10-13. Their API reports no cost, so these prices are what
 * their cost is estimated from.
 */
const HCOMPANY_PRICES: Record<string, { input: number; output: number }> = {
	'holo4-35b-a3b': { input: 0.3, output: 2 },
	'holo4-27b': { input: 0.4, output: 3 },
	'holo3-1-35b-a3b': { input: 0.25, output: 1.8 }
};
const HCOMPANY_PREFIX = 'hcompany/';

export interface BenchModel {
	/** The id as given on the command line, like `qwen/qwen3.8-27b`. */
	id: string;
	/** The id with its slash replaced, for file names. */
	fileName: string;
	provider: Provider;
	/** The id the provider expects. */
	model: string;
	/** List prices in dollars per million tokens. */
	pricePerMillion: { input: number; output: number };
}

/** The parts of OpenRouter's model list the benchmarks use. */
interface OpenRouterModel {
	id: string;
	/** Dollars per token, as decimal strings. */
	pricing: { prompt: string; completion: string };
	architecture: { input_modalities: string[] };
	supported_parameters?: string[];
}

/**
 * Looks the id up before anything is spent: OpenRouter's public model list says whether a model
 * exists, reads images and supports JSON schemas, and what it costs. A typo or a text-only model
 * fails here instead of in the middle of a run.
 */
export async function resolveModel(
	id: string,
	options: { needsImages: boolean } = { needsImages: true }
): Promise<BenchModel> {
	const fileName = id.replaceAll('/', '_');
	if (id.startsWith(HCOMPANY_PREFIX)) {
		const model = id.slice(HCOMPANY_PREFIX.length);
		const price = HCOMPANY_PRICES[model];
		if (price === undefined) {
			throw new Error(
				`No price for ${id}. Known: ${Object.keys(HCOMPANY_PRICES).map((name) => HCOMPANY_PREFIX + name).join(', ')}`
			);
		}
		return { id, fileName, provider: HCOMPANY, model, pricePerMillion: price };
	}

	const response = await fetch(`${OPENROUTER.url}/models`);
	if (!response.ok) throw new Error(`OpenRouter's model list answered ${response.status}`);
	const { data: catalogue } = (await response.json()) as { data: OpenRouterModel[] };
	const listed = catalogue.find((candidate) => candidate.id === id);
	if (listed === undefined) throw new Error(`OpenRouter has no model ${id}`);
	if (options.needsImages && !listed.architecture.input_modalities.includes('image')) {
		throw new Error(`${id} does not read images, and this benchmark sends it a screenshot`);
	}
	if (!(listed.supported_parameters ?? []).includes('structured_outputs')) {
		throw new Error(`${id} has no provider on OpenRouter that supports JSON schemas`);
	}
	return {
		id,
		fileName,
		provider: OPENROUTER,
		model: id,
		pricePerMillion: {
			input: Number(listed.pricing.prompt) * 1_000_000,
			output: Number(listed.pricing.completion) * 1_000_000
		}
	};
}

/** An upstream provider on OpenRouter, and the quantization it must serve. */
export interface Upstream {
	provider: string;
	quantization?: string;
}

/**
 * Splits OpenRouter's `model@provider/quantization` notation, as its model pages show it, like
 * `z-ai/glm-5.3-flash@streamlake/fp8`. Both parts after the model are optional.
 */
export function parseModelSpec(spec: string): { id: string; upstream?: Upstream } {
	const [id, upstreamText] = spec.split('@');
	if (upstreamText === undefined || upstreamText === '') return { id };
	const [provider, quantization] = upstreamText.split('/');
	return { id, upstream: { provider, quantization: quantization || undefined } };
}

export type MessageContent =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

/** How much the model may think before it answers, in OpenRouter's terms. */
export type Reasoning = 'none' | 'minimal' | 'low' | 'medium' | 'high';
export const REASONING_LEVELS: Reasoning[] = ['none', 'minimal', 'low', 'medium', 'high'];

export interface CallResult {
	/** The answer text, empty when the call failed. */
	content: string;
	/** `stop` for a finished answer, `length` when it ran into the token limit. */
	finishReason: string;
	inputTokens: number;
	/** Includes the reasoning tokens, which are billed as output. */
	outputTokens: number;
	reasoningTokens: number;
	cachedInputTokens: number;
	/** Dollars, as the provider reported it, or estimated from the list price. */
	cost: number;
	costIsReported: boolean;
	seconds: number;
	/**
	 * Until the first token of reasoning or answer arrived. The rest of `seconds` is writing, so
	 * this separates a provider's queue and prompt reading from its output speed.
	 */
	firstTokenSeconds?: number;
	/** The upstream provider OpenRouter routed the call to, such as DeepInfra. */
	servedBy?: string;
	/** Set when the call failed; `content` then holds whatever arrived before it did. */
	error?: string;
}

/**
 * A stream that sends nothing for this long is stuck. A long plan may take many minutes to write,
 * so the limit is on silence rather than on the whole call; OpenRouter sends keep-alive comments
 * while a model is still reading the prompt, so even a slow start is not silent.
 */
const SILENCE_TIMEOUT_MS = 2 * 60_000;

/** Reasoning is printed dim while it streams, so it can be told apart from the answer. */
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	cost?: number;
	prompt_tokens_details?: { cached_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
}

/** One server-sent event of an OpenAI-compatible stream, with OpenRouter's additions. */
interface StreamChunk {
	provider?: string;
	/** OpenRouter reports a failure after the stream has started this way. */
	error?: { message: string };
	choices?: {
		finish_reason: string | null;
		delta?: { content?: string | null; reasoning?: string | null };
	}[];
	/** Only on the last chunk. */
	usage?: Usage;
}

/**
 * Sends one request, prints the answer to the console as it streams in, and measures the call. A
 * failure is returned rather than thrown, so whatever arrived and the reason end up in the results.
 */
export async function callModel(
	benchModel: BenchModel,
	request: {
		content: MessageContent[];
		schema: { name: string; schema: object };
		maxTokens: number;
		reasoning: Reasoning;
		/**
		 * The upstream provider OpenRouter must use, by its slug, like `streamlake`, and optionally
		 * the quantization it must serve, like `fp8`. Providers of the same model differ in speed,
		 * price and quantization, so a fair comparison pins one. Undefined lets OpenRouter choose.
		 */
		upstream?: Upstream;
	}
): Promise<CallResult> {
	const { provider } = benchModel;
	const empty: CallResult = {
		content: '',
		finishReason: '',
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		cachedInputTokens: 0,
		cost: 0,
		costIsReported: false,
		seconds: 0
	};
	const apiKey = process.env[provider.apiKeyVariable];
	if (apiKey === undefined || apiKey === '') {
		return { ...empty, error: `${provider.apiKeyVariable} is not set` };
	}
	if (request.upstream !== undefined && !provider.isOpenRouter) {
		return { ...empty, error: `${benchModel.id} is not on OpenRouter, so it has no providers to pick` };
	}
	let routing = {};
	if (request.upstream !== undefined) {
		const { provider: slug, quantization } = request.upstream;
		routing = {
			order: [slug],
			// Without the fallbacks off, OpenRouter would quietly use another provider when this one fails.
			allow_fallbacks: false,
			...(quantization === undefined ? {} : { quantizations: [quantization] })
		};
	}

	const body = {
		model: benchModel.model,
		messages: [{ role: 'user', content: request.content }],
		temperature: 0,
		max_tokens: request.maxTokens,
		response_format: {
			type: 'json_schema',
			json_schema: { ...request.schema, strict: true }
		},
		stream: true,
		...(provider.isOpenRouter
			? {
					reasoning: { effort: request.reasoning },
					// Without this, a provider that does not support JSON schemas gets the request
					// anyway and ignores the schema, which would look like the model's failure.
					provider: { require_parameters: true, ...routing }
				}
			: // OpenRouter always ends a stream with the usage; plain OpenAI-compatible APIs only when asked.
				{ stream_options: { include_usage: true } })
	};

	const abort = new AbortController();
	const silenceError = new Error(`Nothing arrived for ${SILENCE_TIMEOUT_MS / 1000} s`);
	let silenceTimer = setTimeout(() => abort.abort(silenceError), SILENCE_TIMEOUT_MS);
	const startedAt = performance.now();
	const elapsed = () => (performance.now() - startedAt) / 1000;

	let content = '';
	let finishReason = '';
	let usage: Usage | undefined;
	let servedBy: string | undefined;
	let firstTokenSeconds: number | undefined;
	let error: string | undefined;
	try {
		const response = await fetch(`${provider.url}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
			body: JSON.stringify(body),
			signal: abort.signal
		});
		if (!response.ok) {
			return { ...empty, seconds: elapsed(), error: `${response.status}: ${await response.text()}` };
		}

		const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		let unfinishedLine = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			clearTimeout(silenceTimer);
			silenceTimer = setTimeout(() => abort.abort(silenceError), SILENCE_TIMEOUT_MS);

			const lines = (unfinishedLine + value).split('\n');
			unfinishedLine = lines.pop()!;
			for (const line of lines) {
				// Anything else is a comment, like OpenRouter's keep-alive while the model reads the prompt.
				if (!line.startsWith('data: ')) continue;
				const data = line.slice('data: '.length).trim();
				if (data === '[DONE]') continue;
				const chunk = JSON.parse(data) as StreamChunk;
				if (chunk.error !== undefined) error = chunk.error.message;
				if (chunk.provider !== undefined) servedBy = chunk.provider;
				if (chunk.usage !== undefined) usage = chunk.usage;
				const choice = chunk.choices?.[0];
				if (choice === undefined) continue;
				if (choice.finish_reason !== null) finishReason = choice.finish_reason;
				const reasoningText = choice.delta?.reasoning ?? '';
				const contentText = choice.delta?.content ?? '';
				if (firstTokenSeconds === undefined && (reasoningText !== '' || contentText !== '')) {
					firstTokenSeconds = elapsed();
				}
				if (reasoningText !== '') process.stdout.write(`${DIM}${reasoningText}${RESET}`);
				if (contentText !== '') process.stdout.write(contentText);
				content += contentText;
			}
		}
	} catch (failure) {
		// The network dropped, the silence timeout above aborted the stream, or the provider sent a
		// chunk that is not JSON. What arrived is kept, and the reason goes into the results.
		error = (failure as Error).message;
	} finally {
		clearTimeout(silenceTimer);
		process.stdout.write('\n');
	}

	const inputTokens = usage?.prompt_tokens ?? 0;
	const outputTokens = usage?.completion_tokens ?? 0;
	const estimatedCost =
		(inputTokens * benchModel.pricePerMillion.input +
			outputTokens * benchModel.pricePerMillion.output) /
		1_000_000;
	return {
		content,
		finishReason,
		inputTokens,
		outputTokens,
		reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
		cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
		cost: usage?.cost ?? estimatedCost,
		costIsReported: usage?.cost !== undefined,
		seconds: elapsed(),
		firstTokenSeconds,
		servedBy,
		error
	};
}
