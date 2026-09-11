import type { AgentStreamEvent, SessionUsage } from "@wa/protocol";
import type { AgentSession, AgentSessionEvent, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createRemoteSession } from "../agent/session-factory.ts";
import { withBrief } from "../agent/task-prompt.ts";
import type { Env } from "../env.ts";
import type { OpRpc } from "./op-rpc.ts";
import type { Outbox } from "./outbox.ts";
import type { SessionStore } from "./session-store.ts";

const TITLE_MAX_LENGTH = 60;
const TOOL_OUTPUT_PREVIEW = 4_000;
/** Workers caps log data at 256 KB per request; a `write` call alone can exceed that. */
const TOOL_ARGS_LOG_LIMIT = 1000;

/**
 * Per-turn latency accounting.
 *
 * A slow turn has only three possible culprits: the model thinking/generating,
 * the client executing a tool, or our own bookkeeping. The agent loop strictly
 * alternates between "waiting on the LLM" and "waiting on tools", so timing the
 * tool spans and subtracting them from the wall clock attributes the remainder
 * to the model without needing a hook inside pi's streaming code.
 */
class TurnTimer {
	private readonly sessionId: string;
	private readonly startedAt = Date.now();
	/** Wall-clock ms spent inside tool execution (union of spans, not sum). */
	private toolWall = 0;
	private toolDepth = 0;
	private toolSpanStart = 0;
	private firstTokenAt: number | undefined;
	private readonly open = new Map<string, { name: string; at: number }>();
	private readonly byTool = new Map<string, { calls: number; ms: number }>();
	/** Start of the current assistant message, for per-roundtrip LLM latency. */
	private messageStart: number | undefined;
	private messageIndex = 0;
	/** Per-message streaming detail, reset by `messageBegin`. */
	private msgFirstDelta: number | undefined;
	private msgLastDelta: number | undefined;
	private msgThinkChars = 0;
	private msgTextChars = 0;
	private msgArgsChars = 0;
	private msgMaxGap = 0;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	markFirstToken(): void {
		this.firstTokenAt ??= Date.now();
	}

	messageBegin(): void {
		this.messageStart = Date.now();
		this.msgFirstDelta = undefined;
		this.msgThinkChars = 0;
		this.msgTextChars = 0;
		this.msgArgsChars = 0;
		this.msgLastDelta = undefined;
		this.msgMaxGap = 0;
	}

	/**
	 * One streamed delta. Splitting a roundtrip into "time to first delta" and
	 * "time spent streaming" is the only way to tell a slow *provider* from a
	 * verbose *model*: a long prefill means we waited on the gateway (queueing,
	 * cache miss, prompt ingestion), while a long stream with many thinking
	 * characters means the model genuinely generated that much.
	 */
	delta(kind: "thinking" | "text" | "args", chars: number): void {
		const now = Date.now();
		this.msgFirstDelta ??= now;
		if (this.msgLastDelta !== undefined) {
			this.msgMaxGap = Math.max(this.msgMaxGap, now - this.msgLastDelta);
		}
		this.msgLastDelta = now;
		if (kind === "thinking") this.msgThinkChars += chars;
		else if (kind === "args") this.msgArgsChars += chars;
		else this.msgTextChars += chars;
	}

	/** One LLM roundtrip finished. `stopReason` distinguishes a tool hop from the final answer. */
	messageDone(stopReason: string | undefined, contextTokens?: number | null): void {
		if (this.messageStart === undefined) return;
		const now = Date.now();
		const ms = now - this.messageStart;
		const prefill = this.msgFirstDelta === undefined ? ms : this.msgFirstDelta - this.messageStart;
		const stream = this.msgFirstDelta === undefined ? 0 : now - this.msgFirstDelta;
		// ~4 chars/token is close enough to compare roundtrips against each other.
		const emitted = this.msgThinkChars + this.msgTextChars + this.msgArgsChars;
		const rate = stream > 0 ? Math.round((emitted / 4 / stream) * 1000) : 0;
		this.messageStart = undefined;

		console.log(
			`[timing] ${this.sessionId} llm#${++this.messageIndex} ${ms}ms stop=${stopReason ?? "?"}` +
				` prefill=${prefill}ms stream=${stream}ms` +
				` think=${this.msgThinkChars}ch text=${this.msgTextChars}ch args=${this.msgArgsChars}ch` +
				(rate > 0 ? ` ~${rate}tok/s` : "") +
				(contextTokens ? ` ctx=${contextTokens}` : "") +
				(this.msgMaxGap > 2000 ? ` maxGap=${this.msgMaxGap}ms` : ""),
		);
	}

	toolStart(callId: string, name: string): void {
		const now = Date.now();
		// Parallel tool calls overlap; only the outermost span counts toward wall time.
		if (this.toolDepth === 0) {
			this.toolSpanStart = now;
		}
		this.toolDepth++;
		this.open.set(callId, { name, at: now });
	}

	toolEnd(callId: string, name: string, isError: boolean): void {
		const now = Date.now();
		const started = this.open.get(callId);
		this.open.delete(callId);
		if (this.toolDepth > 0) {
			this.toolDepth--;
			if (this.toolDepth === 0) this.toolWall += now - this.toolSpanStart;
		}
		if (!started) return;

		const ms = now - started.at;
		const bucket = this.byTool.get(name) ?? { calls: 0, ms: 0 };
		bucket.calls++;
		bucket.ms += ms;
		this.byTool.set(name, bucket);
		console.log(`[timing] ${this.sessionId} tool ${name} ${ms}ms${isError ? " ERROR" : ""}`);
	}

	/** One line summarising where the turn's wall clock actually went. */
	report(): void {
		const total = Date.now() - this.startedAt;
		const llm = Math.max(0, total - this.toolWall);
		const ttft = this.firstTokenAt ? this.firstTokenAt - this.startedAt : undefined;
		const breakdown = [...this.byTool.entries()]
			.sort((a, b) => b[1].ms - a[1].ms)
			.map(([name, b]) => `${name}×${b.calls}=${b.ms}ms`)
			.join(" ");

		console.log(
			`[timing] ${this.sessionId} TURN total=${total}ms` +
				` llm=${llm}ms(${pct(llm, total)}) tools=${this.toolWall}ms(${pct(this.toolWall, total)})` +
				(ttft === undefined ? "" : ` ttft=${ttft}ms`) +
				` llmCalls=${this.messageIndex}` +
				(breakdown ? ` | ${breakdown}` : ""),
		);
	}
}

function pct(part: number, total: number): string {
	return total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";
}


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
			briefed: history.length > 0,
		});
	}

	get running(): boolean {
		return this.activeTurn !== undefined;
	}

	/**
	 * Runs one turn to completion. The caller must await this from a WebSocket
	 * event handler so the Durable Object stays resident for the whole turn.
	 */
	async prompt(text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
		if (this.disposed) throw new Error("session is closed");

		if (this.activeTurn) {
			if (!streamingBehavior) {
				throw new Error("session is already streaming; pass streamingBehavior 'steer' or 'followUp'");
			}
			await this.session.prompt(text, { streamingBehavior });
			return;
		}

		this.maybeSetTitle(text);

		const timer = new TurnTimer(this.sessionId);
		this.turnTimer = timer;

		const turn = this.session
			.prompt(this.brief(text))
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
	 * The gateway discards `system` messages, so the operating brief is carried
	 * in the first user message instead. Once it is in the transcript it stays
	 * there, and later turns of the session send the user's text unchanged.
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
			case "message_start":
				this.turnTimer?.messageBegin();
				return;
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") {
					this.turnTimer?.markFirstToken();
					this.turnTimer?.delta("text", inner.delta.length);
					this.outbox.push(this.sessionId, { k: "text_delta", text: inner.delta });
				} else if (inner.type === "thinking_delta") {
					this.turnTimer?.markFirstToken();
					this.turnTimer?.delta("thinking", inner.delta.length);
					this.outbox.push(this.sessionId, { k: "thinking_delta", text: inner.delta });
				} else if (inner.type === "toolcall_delta") {
					// Tool arguments stream as their own deltas. For this agent they
					// ARE the deliverable — a `write` call carries the whole file —
					// so leaving them out made long roundtrips look like unexplained
					// stalls (6.2s reported as think=288ch while emitting a 7 KB file).
					this.turnTimer?.markFirstToken();
					this.turnTimer?.delta("args", inner.delta.length);
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
				if (message.role !== "user") {
					this.turnTimer?.messageDone(message.stopReason, this.session.getContextUsage()?.tokens);
				}
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
