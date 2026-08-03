import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Env } from "../env.ts";

/**
 * The gateway is OpenAI-compatible (`/v1/chat/completions`, SSE, `tool_calls`
 * deltas), so pi's `openai-completions` API implementation drives it directly.
 *
 * Everything is in memory: Workers has no durable filesystem, and the API key
 * must stay in the Workers secret store rather than in a session file.
 */

export const GATEWAY_PROVIDER_ID = "gateway";

interface CatalogEntry {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

/** Mirrors the gateway's `/v1/models`. Adjust when the gateway catalog changes. */
const MODEL_CATALOG: CatalogEntry[] = [
	{ id: "claude-opus-4.8", name: "Claude Opus 4.8", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
	{ id: "claude-opus-4.7", name: "Claude Opus 4.7", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
	{ id: "claude-opus-4.5", name: "Claude Opus 4.5", reasoning: true, contextWindow: 128_000, maxTokens: 16_000 },
	{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 128_000, maxTokens: 16_000 },
	{ id: "gpt-5.5", name: "GPT-5.5", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
];

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export async function createModelRuntime(env: Env): Promise<ModelRuntime> {
	if (!env.LLM_API_KEY) {
		throw new Error("LLM_API_KEY is not configured (wrangler secret put LLM_API_KEY)");
	}

	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});

	runtime.registerProvider(GATEWAY_PROVIDER_ID, {
		name: "LLM Gateway",
		baseUrl: env.LLM_BASE_URL,
		apiKey: env.LLM_API_KEY,
		api: "openai-completions",
		models: MODEL_CATALOG.map((entry) => ({
			id: entry.id,
			name: entry.name,
			reasoning: entry.reasoning,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
		})),
	});

	return runtime;
}

export function resolveModel(runtime: ModelRuntime, env: Env, requested?: string): Model<string> {
	const modelId = requested?.trim() || env.DEFAULT_MODEL;
	const model = runtime.getModel(GATEWAY_PROVIDER_ID, modelId);
	if (!model) {
		const known = MODEL_CATALOG.map((entry) => entry.id).join(", ");
		throw new Error(`unknown model "${modelId}". Available: ${known}`);
	}
	return model;
}

/**
 * Resolves the model a session was last using.
 *
 * Falls back to the default when the persisted reference is no longer in the
 * gateway catalog, so a retired model cannot make an existing session
 * permanently unopenable.
 */
export function resolveRestoredModel(
	runtime: ModelRuntime,
	env: Env,
	persisted: { provider: string; modelId: string } | null | undefined,
): Model<string> {
	if (persisted?.provider === GATEWAY_PROVIDER_ID) {
		const model = runtime.getModel(GATEWAY_PROVIDER_ID, persisted.modelId);
		if (model) return model;
	}
	return resolveModel(runtime, env);
}

export function listModelIds(): string[] {
	return MODEL_CATALOG.map((entry) => entry.id);
}
