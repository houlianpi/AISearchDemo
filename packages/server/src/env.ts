export interface LocalConfig {
	model: string;
	sessionTtlMs: number;
	demoSearchFallback: boolean;
}

export function localConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
	return {
		model: env.PI_MODEL?.trim() || "github-copilot/gpt-5.6-sol",
		sessionTtlMs: 10 * 60 * 1000,
		demoSearchFallback: env.DEMO_SEARCH_FALLBACK === "true",
	};
}
