import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Some OpenAI-compatible models emit both `query` and an empty `queries` array.
 * pi-web-access treats any array as authoritative, so the empty array masks the
 * valid singular query and returns "No query provided". Normalize before the
 * plugin's TypeBox validation and execution without changing any other option.
 */
export function normalizeWebSearchArguments(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const args = { ...(value as Record<string, unknown>) };
	if (Array.isArray(args.queries) && args.queries.length === 0 && typeof args.query === "string" && args.query.trim()) {
		delete args.queries;
	}
	return args;
}

export function createNormalizedWebSearchTool(definition: ToolDefinition): ToolDefinition {
	return {
		...definition,
		prepareArguments: (value) => {
			const normalized = normalizeWebSearchArguments(value);
			return definition.prepareArguments ? definition.prepareArguments(normalized) : normalized as never;
		},
	};
}
