import type { UserAgentDO } from "./do/user-agent-do.ts";

export interface Env {
	USER_AGENT: DurableObjectNamespace<UserAgentDO>;

	/** OpenAI-compatible gateway base URL, including the `/v1` suffix. */
	LLM_BASE_URL: string;
	/** Secret. Set via `wrangler secret put LLM_API_KEY` or `.dev.vars`. */
	LLM_API_KEY: string;
	DEFAULT_MODEL: string;
	/** Max sessions allowed to stream concurrently inside one user's Durable Object. */
	MAX_CONCURRENT_TURNS?: string;
}

export function maxConcurrentTurns(env: Env): number {
	const parsed = Number.parseInt(env.MAX_CONCURRENT_TURNS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}
