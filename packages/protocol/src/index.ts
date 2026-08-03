/**
 * Wire protocol between the browser/CLI client and the Cloudflare agent server.
 *
 * Design notes:
 * - JSON over a single WebSocket. Command/response pairs are correlated by `id`.
 * - Agent output is pushed as batched `stream` frames to keep WebSocket frame
 *   count low (Cloudflare recommends batching over per-token frames).
 * - Tools run on the client. The server issues `op.call` RPCs that mirror pi's
 *   pluggable `*Operations` interfaces, so pi's own tool implementations stay
 *   intact and only their IO layer is remoted.
 */

export const PROTOCOL_VERSION = 1;

/**
 * The agent always reasons about paths under this POSIX root.
 *
 * Path resolution happens server-side with `node:path`, which is POSIX-only on
 * Workers, so a native client path (`D:\repo`) would resolve incorrectly. The
 * client maps `/workspace/...` onto its real working directory and rejects
 * anything that escapes it.
 */
export const VIRTUAL_ROOT = "/workspace";

// ---------------------------------------------------------------------------
// Remote operations (server -> client RPC)
// ---------------------------------------------------------------------------

export interface RemoteOpMap {
	"bash.exec": {
		args: {
			command: string;
			cwd: string;
			timeoutMs?: number;
			/** pi's `PI_*` session variables only; merged over the client's own environment. */
			env?: Record<string, string>;
		};
		result: { exitCode: number | null };
	};
	"fs.readFile": {
		args: { path: string };
		/** base64 so binary files (images) survive the JSON hop */
		result: { base64: string };
	};
	"fs.writeFile": {
		args: { path: string; content: string };
		result: Record<string, never>;
	};
	"fs.mkdir": {
		args: { path: string };
		result: Record<string, never>;
	};
	"fs.access": {
		args: { path: string; mode: "r" | "rw" };
		result: Record<string, never>;
	};
	"fs.stat": {
		args: { path: string };
		result: { isDirectory: boolean; size: number };
	};
	"fs.readdir": {
		args: { path: string };
		result: { entries: string[] };
	};
	"fs.exists": {
		args: { path: string };
		result: { exists: boolean };
	};
	"fs.glob": {
		args: { pattern: string; cwd: string; ignore: string[]; limit: number };
		result: { paths: string[] };
	};
	"fs.imageMimeType": {
		args: { path: string };
		result: { mimeType: string | null };
	};
}

export type RemoteOpName = keyof RemoteOpMap;
export type RemoteOpArgs<K extends RemoteOpName = RemoteOpName> = RemoteOpMap[K]["args"];
export type RemoteOpResult<K extends RemoteOpName = RemoteOpName> = RemoteOpMap[K]["result"];

// ---------------------------------------------------------------------------
// Agent stream events (server -> client, batched)
// ---------------------------------------------------------------------------

export type AgentStreamEvent =
	| { k: "text_delta"; text: string }
	| { k: "thinking_delta"; text: string }
	| { k: "tool_start"; toolCallId: string; name: string; args: unknown }
	| { k: "tool_update"; toolCallId: string; text: string }
	| { k: "tool_end"; toolCallId: string; name: string; isError: boolean; output: string }
	| { k: "message_end"; role: string; stopReason?: string; errorMessage?: string }
	| { k: "turn_end" }
	| { k: "agent_end"; usage?: SessionUsage }
	| { k: "compaction"; phase: "start" | "end" }
	| { k: "aborted"; reason: string }
	| { k: "error"; message: string };

export interface SessionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SessionSummary {
	sessionId: string;
	title: string | null;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	entryCount: number;
	running: boolean;
}

/** A persisted pi session entry, replayed verbatim on resume. */
export interface StoredEntry {
	seq: number;
	entryId: string;
	type: string;
	/** Raw pi `SessionEntry` JSON. The client only needs it for transcript rendering. */
	entry: unknown;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
	| { t: "hello"; protocolVersion: number; cwd: string; clientInfo?: string }
	| { t: "session.list"; id: string }
	| { t: "session.create"; id: string; cwd?: string; title?: string; model?: string }
	| { t: "session.attach"; id: string; sessionId: string; sinceSeq?: number }
	| { t: "session.detach"; id: string; sessionId: string }
	| { t: "session.delete"; id: string; sessionId: string }
	| { t: "prompt"; id: string; sessionId: string; text: string; streamingBehavior?: "steer" | "followUp" }
	| { t: "abort"; id: string; sessionId: string }
	| { t: "op.result"; callId: string; ok: true; result: unknown }
	| { t: "op.result"; callId: string; ok: false; error: string }
	| { t: "op.update"; callId: string; base64: string }
	| { t: "ping"; id: string };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMessage =
	| { t: "ready"; protocolVersion: number; userId: string; sessions: SessionSummary[]; maxConcurrentTurns: number }
	| { t: "ack"; id: string; ok: true; data?: unknown }
	| { t: "ack"; id: string; ok: false; error: string }
	| { t: "history"; sessionId: string; entries: StoredEntry[]; lastSeq: number }
	| { t: "stream"; sessionId: string; events: AgentStreamEvent[] }
	| { t: "session.updated"; session: SessionSummary }
	| { t: "op.call"; callId: string; sessionId: string; op: RemoteOpName; args: RemoteOpArgs; timeoutMs: number }
	| { t: "op.abort"; callId: string }
	| { t: "fatal"; message: string };

export function isClientMessage(value: unknown): value is ClientMessage {
	return typeof value === "object" && value !== null && typeof (value as { t?: unknown }).t === "string";
}
