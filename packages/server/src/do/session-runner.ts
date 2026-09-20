import { Buffer } from "node:buffer";
import type { AgentStreamEvent, PromptImage, SessionUsage } from "@wa/protocol";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createRemoteSession } from "../agent/session-factory.ts";
import { requiresUserBrief } from "../agent/model.ts";
import { stripEmbeddedBrief, withBrief } from "../agent/task-prompt.ts";
import type { Env } from "../env.ts";
import type { OpRpc } from "./op-rpc.ts";
import type { Outbox } from "./outbox.ts";
import { MAX_ENTRY_BYTES, type SessionStore } from "./session-store.ts";
import { TurnTimer } from "./turn-timer.ts";

const TITLE_MAX_LENGTH = 60;
const TOOL_OUTPUT_PREVIEW = 4_000;
/** Workers caps log data at 256 KB per request; a `write` call alone can exceed that. */
const TOOL_ARGS_LOG_LIMIT = 1000;

/** Events after which the entry log is drained to SQLite. */
const PERSIST_AFTER = new Set<AgentSessionEvent["type"]>([
	"message_end",
	"turn_end",
	"tool_execution_end",
	"compaction_end",
	"agent_end",
]);

/**
 * Owns one live pi `AgentSession` inside the Durable Object.
 *
 * The runner is pure in-memory state and is rebuilt from SQLite whenever the DO
 * restarts, so nothing here may be treated as durable. Everything that must
 * survive is drained out of the session's entry log into `SessionStore`.
 */
export class SessionRunner {
	readonly sessionId: string;
	readonly cwd: string;
	private readonly session: AgentSession;
	private readonly sessionManager: SessionManager;
	private readonly store: SessionStore;
	private readonly outbox: Outbox;
	private readonly unsubscribe: () => void;
	private persistedEntries: number;
	private briefed: boolean;
	private activeTurn: Promise<void> | undefined;
	private turnTimer: TurnTimer | undefined;
	private disposed = false;

	private constructor(params: {
		sessionId: string;
		cwd: string;
		session: AgentSession;
		sessionManager: SessionManager;
		store: SessionStore;
		outbox: Outbox;
		persistedEntries: number;
		briefed: boolean;
	}) {
		this.sessionId = params.sessionId;
		this.cwd = params.cwd;
		this.session = params.session;
		this.sessionManager = params.sessionManager;
		this.store = params.store;
		this.outbox = params.outbox;
		this.persistedEntries = params.persistedEntries;
		this.briefed = params.briefed;
		const streamFn = this.session.agent.streamFunction;
		this.session.agent.streamFunction = (model, context, options) =>
			this.turnTimer ? this.turnTimer.stream(streamFn, model, context, options) : streamFn(model, context, options);
		this.unsubscribe = this.session.subscribe((event) => this.onAgentEvent(event));
	}

	static async open(params: {
		env: Env;
		modelRuntime: ModelRuntime;
		rpc: OpRpc;
		store: SessionStore;
		outbox: Outbox;
		sessionId: string;
		cwd: string;
		modelId?: string;
	}): Promise<SessionRunner> {
		const history = params.store.readEntries(params.sessionId);
		const { session, sessionManager } = await createRemoteSession({
			env: params.env,
			modelRuntime: params.modelRuntime,
			rpc: params.rpc,
			sessionId: params.sessionId,
			history,
			modelId: params.modelId,
		});
		return new SessionRunner({
			sessionId: params.sessionId,
			cwd: params.cwd,
			session,
			sessionManager,
			store: params.store,
			outbox: params.outbox,
			// A restored session recreates its model/thinking-level entries in memory,
			// so skip them; a brand-new session must persist them or the next restore
			// cannot tell which model and thinking level it was using.
			persistedEntries: history.length > 0 ? sessionManager.getEntries().length : 0,
			// A switch from copilot to a legacy upstream may need a first user copy.
			briefed: !requiresUserBrief(params.env) || session.messages.some(
				(message) => message.role === "user" && stripEmbeddedBrief(message) !== message,
			),
		});
	}

	get running(): boolean {
		return this.activeTurn !== undefined;
	}

	/** Called before the WebSocket ack; rechecked on entry for direct SDK callers and queued turns. */
	validatePrompt(text: string, streamingBehavior?: "steer" | "followUp", images: readonly PromptImage[] = []): void {
		if (this.disposed) throw new Error("session is closed");
		if (!text.trim() && images.length === 0) throw new Error("A prompt needs text or at least one image.");
		if (this.activeTurn && !streamingBehavior) {
			throw new Error("session is already streaming; pass streamingBehavior 'steer' or 'followUp'");
		}
		const hasImageHistory = !this.session.model?.input.includes("image") && this.session.messages.some(
			(message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
		);
		if (!this.session.model?.input.includes("image") && (images.length > 0 || hasImageHistory)) {
			throw new Error(`Model ${this.session.model?.id ?? "(none)"} does not support image input.`);
		}
		const content = [
			{ type: "text", text: this.briefed || this.activeTurn ? text : withBrief(text) },
			...images.map((image) => ({ type: "image", ...image })),
		];
		if (Buffer.byteLength(JSON.stringify({ role: "user", content }), "utf-8") > MAX_ENTRY_BYTES - 4096) {
			throw new Error("Prompt is too large to persist safely. Reduce the text or image sizes.");
		}
	}

	/**
	 * Runs one turn to completion. The caller must await this from a WebSocket
	 * event handler so the Durable Object stays resident for the whole turn.
	 */
	async prompt(text: string, streamingBehavior?: "steer" | "followUp", images: readonly PromptImage[] = []): Promise<void> {
		this.validatePrompt(text, streamingBehavior, images);
		const imageContent: ImageContent[] = images.map((image) => ({ type: "image", ...image }));

		if (this.activeTurn) {
			await this.session.prompt(text, { streamingBehavior, images: imageContent });
			return;
		}

		this.maybeSetTitle(text.trim() ? text : "Image message");

		const timer = new TurnTimer(this.sessionId);
		this.turnTimer = timer;

		const turn = this.session
			.prompt(this.brief(text), { images: imageContent })
			.catch((error: unknown) => {
				this.outbox.push(this.sessionId, { k: "error", message: errorMessage(error) });
			})
			.finally(() => {
				this.activeTurn = undefined;
				this.turnTimer = undefined;
				timer.report();
				this.persist();
				this.outbox.pushAndFlush(this.sessionId, { k: "agent_end", usage: this.usage() });
			});
		this.activeTurn = turn;
		await turn;
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	/**
	 * Legacy upstreams retain the user-message fallback. The copilot provider
	 * uses its system prompt and starts with `briefed` already true.
	 */
	private brief(text: string): string {
		if (this.briefed) return text;
		this.briefed = true;
		return withBrief(text);
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.session.dispose();
	}

	usage(): SessionUsage {
		const stats = this.session.getSessionStats();
		return {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			cost: stats.cost,
		};
	}

	/** Drains newly appended entries into durable storage. */
	private persist(): void {
		const entries = this.sessionManager.getEntries();
		for (let index = this.persistedEntries; index < entries.length; index++) {
			const entry = entries[index];
			if (!entry) continue;
			this.store.appendEntry(this.sessionId, entry.id, entry.type, entry);
		}
		this.persistedEntries = entries.length;
	}

	private maybeSetTitle(text: string): void {
		const row = this.store.getSession(this.sessionId);
		if (row?.title) return;
		const title = text.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_LENGTH);
		if (title) this.store.setTitle(this.sessionId, title);
	}

	private onAgentEvent(event: AgentSessionEvent): void {
		if (PERSIST_AFTER.has(event.type)) this.persist();

		switch (event.type) {
			case "entry_appended":
				this.persist();
				return;
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") {
					this.outbox.push(this.sessionId, { k: "text_delta", text: inner.delta });
				} else if (inner.type === "thinking_delta") {
					this.outbox.push(this.sessionId, { k: "thinking_delta", text: inner.delta });
				}
				return;
			}
			case "tool_execution_start":
				this.turnTimer?.toolStart(event.toolCallId, event.toolName);
				console.log(
					`[tool] ${this.sessionId} ${event.toolCallId} ${event.toolName} ${formatArgsForLog(event.args)}`,
				);
				this.outbox.push(this.sessionId, {
					k: "tool_start",
					toolCallId: event.toolCallId,
					name: event.toolName,
					args: event.args,
				});
				return;
			case "tool_execution_update":
				this.outbox.push(this.sessionId, {
					k: "tool_update",
					toolCallId: event.toolCallId,
					text: extractText(event.partialResult, 512),
				});
				return;
			case "tool_execution_end":
				this.turnTimer?.toolEnd(event.toolCallId, event.toolName, event.isError);
				this.outbox.push(this.sessionId, {
					k: "tool_end",
					toolCallId: event.toolCallId,
					name: event.toolName,
					isError: event.isError,
					output: extractText(event.result, TOOL_OUTPUT_PREVIEW),
				});
				return;
			case "message_end": {
				const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
				this.outbox.push(this.sessionId, {
					k: "message_end",
					role: message.role ?? "assistant",
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
				});
				return;
			}
			case "turn_end":
				this.outbox.push(this.sessionId, { k: "turn_end" });
				return;
			case "compaction_start":
				this.outbox.push(this.sessionId, { k: "compaction", phase: "start" });
				return;
			case "compaction_end":
				this.outbox.push(this.sessionId, { k: "compaction", phase: "end" });
				return;
			default:
				return;
		}
	}
}

function formatArgsForLog(args: unknown): string {
	const text = typeof args === "string" ? args : (JSON.stringify(args) ?? String(args));
	return text.length > TOOL_ARGS_LOG_LIMIT ? `${text.slice(0, TOOL_ARGS_LOG_LIMIT)}… (${text.length} chars)` : text;
}

function extractText(result: unknown, limit: number): string {
	if (result === undefined || result === null) return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			text += (part as { text?: string }).text ?? "";
		}
		if (text.length >= limit) break;
	}
	return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type { AgentStreamEvent };
