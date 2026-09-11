import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, type Model, type OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Env } from "../env.ts";

/**
 * Both upstreams are OpenAI-compatible (`/v1/chat/completions`, SSE, `tool_calls`
 * deltas), so pi's `openai-completions` API implementation drives them directly.
 *
 * Exactly one provider is live per deployment, selected by `LLM_PROVIDER`.
 * Switching is a config change plus a redeploy — there is no per-session choice.
 *
 * Everything is in memory: Workers has no durable filesystem, and the API keys
 * must stay in the Workers secret store rather than in a session file.
 */

export const GATEWAY_PROVIDER_ID = "gateway";
export const DEEPSEEK_PROVIDER_ID = "deepseek";

/** The `LLM_PROVIDER` value used when the variable is unset. */
const DEFAULT_PROVIDER_ID = GATEWAY_PROVIDER_ID;

interface CatalogEntry {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	/** Defaults to text-only; set explicitly for vision-capable models. */
	vision?: boolean;
}

interface ProviderDefinition {
	id: string;
	name: string;
	baseUrl: (env: Env) => string | undefined;
	apiKey: (env: Env) => string | undefined;
	defaultModel: (env: Env) => string | undefined;
	/** The secret name to quote when the key is missing. */
	apiKeyVar: string;
	catalog: CatalogEntry[];
	compat: OpenAICompletionsCompat;
	/**
	 * Thinking level for new sessions, when the provider should not use pi's
	 * default of "medium". Restored sessions keep whatever they were using.
	 */
	defaultThinkingLevel?: ThinkingLevel;
}

/** Mirrors the Anthropic/OpenAI gateway's `/v1/models`. */
const GATEWAY_CATALOG: CatalogEntry[] = [
	{ id: "claude-opus-4.8", name: "Claude Opus 4.8", reasoning: true, contextWindow: 200_000, maxTokens: 32_000, vision: true },
	{ id: "claude-opus-4.7", name: "Claude Opus 4.7", reasoning: true, contextWindow: 200_000, maxTokens: 32_000, vision: true },
	{ id: "claude-opus-4.5", name: "Claude Opus 4.5", reasoning: true, contextWindow: 128_000, maxTokens: 16_000, vision: true },
	{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 128_000, maxTokens: 16_000, vision: true },
	{ id: "gpt-5.6-sol", name: "GPT-5.6 SOL", reasoning: true, contextWindow: 200_000, maxTokens: 32_000, vision: true },
	{ id: "gpt-5.5", name: "GPT-5.5", reasoning: true, contextWindow: 200_000, maxTokens: 32_000, vision: true },
];

/**
 * Mirrors the DeepSeek gateway's `/v1/models`. Only `-vision-exp` accepts images.
 *
 * Both limits are measured against the live gateway, not guessed:
 *  - contextWindow: 1_032_229 prompt tokens accepted; 1_214_367 rejected with
 *    "maximum context length is 1048576 tokens".
 *  - maxTokens: the endpoint accepts up to at least 131_072. Capped well below
 *    that here because flash streams at ~211 tok/s, so the value doubles as a
 *    worst-case latency bound (65_536 ≈ 5 min). It is a ceiling, not a target:
 *    a normal reply still stops on its own.
 */
const DEEPSEEK_CATALOG: CatalogEntry[] = [
	{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, contextWindow: 1_048_576, maxTokens: 65_536 },
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, contextWindow: 1_048_576, maxTokens: 65_536 },
	{
		id: "deepseek-v4-flash-vision-exp",
		name: "DeepSeek V4 Flash Vision (exp)",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		vision: true,
	},
];

const PROVIDERS: ProviderDefinition[] = [
	{
		id: GATEWAY_PROVIDER_ID,
		name: "LLM Gateway",
		baseUrl: (env) => env.LLM_BASE_URL,
		apiKey: (env) => env.LLM_API_KEY,
		defaultModel: (env) => env.DEFAULT_MODEL,
		apiKeyVar: "LLM_API_KEY",
		catalog: GATEWAY_CATALOG,
		// pi sends the system prompt as `role: "developer"` for reasoning models
		// on unrecognised OpenAI-compatible endpoints. This gateway silently
		// drops that role, so every system prompt vanished before this was set.
		compat: { supportsDeveloperRole: false },
	},
	{
		id: DEEPSEEK_PROVIDER_ID,
		name: "DeepSeek Gateway",
		baseUrl: (env) => env.DEEPSEEK_BASE_URL,
		apiKey: (env) => env.DEEPSEEK_API_KEY,
		defaultModel: (env) => env.DEEPSEEK_DEFAULT_MODEL,
		apiKeyVar: "DEEPSEEK_API_KEY",
		catalog: DEEPSEEK_CATALOG,
		compat: {
			// Rejects `developer` outright: "unknown variant `developer`, expected
			// one of `system`, `user`, `assistant`, `tool`".
			supportsDeveloperRole: false,
			// Accepts `thinking: { type }` alongside `reasoning_effort`; reasoning
			// streams back in `reasoning_content`, which pi already parses.
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		},
		// Reasoning on, at the lowest useful setting.
		//
		// It is worth being explicit about why this is not "off", because turning
		// it off looked like a huge win: a 488 KB page build went 274s -> 116s.
		// The catch is that the deliberation did not stop, it just moved — with no
		// reasoning channel the model streams the same thinking through `content`,
		// which is the user's chat window. Measured: ~25 KB of narration leaked
		// across a single turn, and three rounds of prompt wording could not move
		// that number (25458 -> 24413 -> 25376 chars), because a prompt cannot
		// control which field a model writes to.
		//
		// "low" keeps reasoning in `reasoning_content` where it belongs while
		// avoiding the runaway seen at pi's default of "medium" (one roundtrip
		// spent 151s emitting 67_994 chars of reasoning to produce a single tool
		// call, growing non-linearly with context). Message length is handled
		// where it belongs — by the budget in the brief, not by muting the model.
		defaultThinkingLevel: "low",
	},
];

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function providerDefinition(env: Env): ProviderDefinition {
	const requested = env.LLM_PROVIDER?.trim() || DEFAULT_PROVIDER_ID;
	const provider = PROVIDERS.find((entry) => entry.id === requested);
	if (!provider) {
		const known = PROVIDERS.map((entry) => entry.id).join(", ");
		throw new Error(`unknown LLM_PROVIDER "${requested}". Available: ${known}`);
	}
	return provider;
}

/** The provider id that this deployment's sessions run against. */
export function activeProviderId(env: Env): string {
	return providerDefinition(env).id;
}

export async function createModelRuntime(env: Env): Promise<ModelRuntime> {
	const provider = providerDefinition(env);
	const baseUrl = provider.baseUrl(env);
	const apiKey = provider.apiKey(env);

	if (!baseUrl) {
		throw new Error(`${provider.id} provider is selected but its base URL is not configured`);
	}
	if (!apiKey) {
		throw new Error(`${provider.apiKeyVar} is not configured (wrangler secret put ${provider.apiKeyVar})`);
	}

	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});

	// Only the selected provider is registered. Registering both would make a
	// missing second key a hard startup failure even when it is never used.
	runtime.registerProvider(provider.id, {
		name: provider.name,
		baseUrl,
		apiKey,
		api: "openai-completions",
		models: provider.catalog.map((entry) => ({
			id: entry.id,
			name: entry.name,
			reasoning: entry.reasoning,
			input: entry.vision ? ["text", "image"] : ["text"],
			cost: ZERO_COST,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
			compat: provider.compat,
		})),
	});

	return runtime;
}

export function resolveModel(runtime: ModelRuntime, env: Env, requested?: string): Model<string> {
	const provider = providerDefinition(env);
	const fallback = provider.defaultModel(env)?.trim() || provider.catalog[0]?.id;
	const modelId = requested?.trim() || fallback;
	if (!modelId) throw new Error(`no default model configured for provider "${provider.id}"`);

	const model = runtime.getModel(provider.id, modelId);
	if (!model) {
		const known = provider.catalog.map((entry) => entry.id).join(", ");
		throw new Error(`unknown model "${modelId}" for provider "${provider.id}". Available: ${known}`);
	}
	return model;
}

/**
 * Resolves the model a session was last using.
 *
 * Falls back to the default when the persisted reference is no longer available
 * — either because the model was retired, or because `LLM_PROVIDER` now points
 * at a different upstream. That keeps existing sessions openable across a
 * provider switch, at the cost of migrating them onto the new default model.
 */
export function resolveRestoredModel(
	runtime: ModelRuntime,
	env: Env,
	persisted: { provider: string; modelId: string } | null | undefined,
): Model<string> {
	const provider = providerDefinition(env);
	if (persisted?.provider === provider.id) {
		const model = runtime.getModel(provider.id, persisted.modelId);
		if (model) return model;
	}
	return resolveModel(runtime, env);
}

export function listModelIds(env: Env): string[] {
	return providerDefinition(env).catalog.map((entry) => entry.id);
}

/**
 * Thinking level to use for a brand-new session, or undefined to let pi apply
 * its own default ("medium"). Gateway is unaffected.
 */
export function defaultThinkingLevel(env: Env): ThinkingLevel | undefined {
	return providerDefinition(env).defaultThinkingLevel;
}

