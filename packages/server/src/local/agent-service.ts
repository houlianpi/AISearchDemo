import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { localConfig, type LocalConfig } from "../env.ts";
import { HttpError, type MessageRequest, type MessageResponse } from "./contracts.ts";
import { resolveImage } from "./images.ts";
import { createLocalModelRuntime, resolveLocalModel } from "./model.ts";
import { enrichTopSearchResults } from "./result-metadata.ts";
import { createSubmitResponseTool, type SubmittedResponse } from "./result-tool.ts";
import { demoFallbackResults, searchResultsFromEntries } from "./search-results.ts";
import { SessionCache } from "./session-cache.ts";
import { createNormalizedWebSearchTool } from "./web-search-tool.ts";

export const AGENT_THINKING_LEVEL = "low" as const;
export const SYSTEM_PROMPT = `You are the backend agent for an image AI search demo.
For a message with an image: understand the image first, call web_search with useful identifying keywords, then synthesize the answer from the image and search evidence.
For a text-only follow-up: use conversation context and call web_search only when current web evidence would improve the answer.
For each user message, make one primary web_search call. Pass exactly one concise query using the query field, set workflow to "none", set includeContent to false, and request no more than 5 results. Never use the queries field.
Only when the primary search returns an error or zero results, make one retry with a shorter query containing the identified brand and product/model name. Use the same workflow, includeContent, and result limit. Never make more than two web_search calls total.
Keep links and source lists out of the answer. Search result links are rendered separately by the application. If both searches fail, give a concise image-only answer without inventing, guessing, or listing URLs.
Search failures are non-fatal; provide the best answer you can. Never invent search results.
Always finish by calling submit_response exactly once. Do not return the final answer as plain assistant text.`;
const require = createRequire(import.meta.url);

interface LiveSession {
	session: AgentSession;
	sessionManager: SessionManager;
	lastSubmission?: SubmittedResponse;
	dispose(): void;
}

export interface AgentServiceOptions {
	config?: LocalConfig;
	now?: () => number;
	runtimeFactory?: () => Promise<ModelRuntime>;
	fetcher?: typeof fetch;
}

export class AgentService {
	private readonly sessions: SessionCache<LiveSession>;
	private readonly config: LocalConfig;
	private readonly now: () => number;
	private readonly runtimeFactory: () => Promise<ModelRuntime>;
	private readonly fetcher: typeof fetch;
	private runtime?: Promise<ModelRuntime>;

	constructor(options: AgentServiceOptions = {}) {
		this.config = options.config ?? localConfig();
		this.now = options.now ?? Date.now;
		this.sessions = new SessionCache(this.config.sessionTtlMs, this.now);
		this.runtimeFactory = options.runtimeFactory ?? createLocalModelRuntime;
		this.fetcher = options.fetcher ?? fetch;
	}

	async message(sessionId: string, request: MessageRequest): Promise<MessageResponse> {
		validateSessionId(sessionId);
		if (!request || typeof request !== "object" || typeof request.prompt !== "string" || !request.prompt.trim()) {
			throw new HttpError(400, "INVALID_PROMPT", "prompt must be a non-empty string.");
		}
		const image = await resolveImage(request.image, this.fetcher);
		const live = await this.sessionFor(sessionId);
		if (live.session.isStreaming) throw new HttpError(409, "SESSION_BUSY", "This session is already processing a request.");

		const entryStart = live.sessionManager.getEntries().length;
		live.lastSubmission = undefined;
		const unsubscribe = live.session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "web_search" && event.isError) {
				console.warn("web_search failed:", toolErrorMessage(event.result));
			}
		});
		try {
			await live.session.prompt(request.prompt.trim(), image ? { images: [image] } : undefined);
		} finally {
			unsubscribe();
		}
		const submitted = live.lastSubmission ?? answerFromMessages(live.session.messages, image);
		const submission: SubmittedResponse = {
			answer: submitted.answer,
			imageAnalysis: image
				? (submitted.imageAnalysis ?? { description: submitted.answer, keywords: [] })
				: null,
		};
		let searchResults = searchResultsFromEntries(live.sessionManager.getEntries(), entryStart);
		const searchCalled = searchWasCalled(live.sessionManager.getEntries(), entryStart);
		let searchMode: MessageResponse["searchMode"] = searchCalled ? (searchResults.length ? "live" : "unavailable") : "not-used";
		if (searchCalled && searchResults.length === 0 && this.config.demoSearchFallback) {
			searchResults = demoFallbackResults();
			searchMode = "demo-fallback";
		}
		searchResults = await enrichTopSearchResults(searchResults, { fetcher: this.fetcher });
		return { sessionId, ...submission, searchResults, searchMode };
	}

	private async sessionFor(sessionId: string): Promise<LiveSession> {
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;
	
		this.runtime ??= this.runtimeFactory();
		const runtime = await this.runtime;
		const model = resolveLocalModel(runtime, this.config.model);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: true },
			retry: { enabled: true, maxRetries: 1 },
		});
		const agentDir = getAgentDir();
		const webAccessPath = join(dirname(require.resolve("pi-web-access/package.json")), "index.ts");
		const resourceLoader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir,
			settingsManager,
			additionalExtensionPaths: [webAccessPath],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => SYSTEM_PROMPT,
		});
		await resourceLoader.reload();
		const loaded = resourceLoader.getExtensions();
		if (loaded.errors.length > 0 || !loaded.extensions.some((extension) => extension.tools.has("web_search"))) {
			throw new HttpError(500, "SEARCH_PLUGIN_LOAD_FAILED", loaded.errors.map((error) => error.error).join("; ") || "pi-web-access did not register web_search.");
		}
		const webSearchDefinition = loaded.extensions
			.flatMap((extension) => [...extension.tools.values()])
			.find((tool) => tool.definition.name === "web_search")?.definition;
		if (!webSearchDefinition) throw new HttpError(500, "SEARCH_PLUGIN_LOAD_FAILED", "pi-web-access did not expose web_search.");

		const sessionManager = SessionManager.inMemory(process.cwd(), { id: sessionId });
		const live: LiveSession = {
			session: undefined as unknown as AgentSession,
			sessionManager,
			dispose: () => live.session.dispose(),
		};
		const submitTool = createSubmitResponseTool((response) => { live.lastSubmission = response; });
		const { session } = await createAgentSession({
			cwd: process.cwd(), agentDir, modelRuntime: runtime, model, thinkingLevel: AGENT_THINKING_LEVEL,
			settingsManager, resourceLoader, sessionManager, customTools: [createNormalizedWebSearchTool(webSearchDefinition), submitTool],
			tools: ["web_search", "submit_response"],
		});
		live.session = session;
		this.sessions.set(sessionId, live);
		return live;
	}
}

function validateSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
		throw new HttpError(400, "INVALID_SESSION_ID", "sessionId must contain 1-128 letters, numbers, underscores, or hyphens.");
	}
}

function answerFromMessages(messages: AgentSession["messages"], image?: ImageContent): SubmittedResponse {
	const assistant = [...messages].reverse().find((message) => message.role === "assistant");
	const answer = assistant?.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
	if (!answer) throw new HttpError(502, "MODEL_RESPONSE_INVALID", "The model did not submit a final response.");
	return { answer, imageAnalysis: image ? { description: answer, keywords: [] } : null };
}

function searchWasCalled(entries: readonly import("@earendil-works/pi-coding-agent").SessionEntry[], fromIndex: number): boolean {
	return entries.slice(fromIndex).some((entry) =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "web_search",
	);
}

function toolErrorMessage(result: unknown): string {
	if (!result || typeof result !== "object") return String(result);
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "Unknown web search error";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join(" ")
		.slice(0, 1_000) || "Unknown web search error";
}
