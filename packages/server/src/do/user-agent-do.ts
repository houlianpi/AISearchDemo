import { DurableObject } from "cloudflare:workers";
import {
	type ClientMessage,
	isClientMessage,
	PROTOCOL_VERSION,
	type ServerMessage,
	type SessionSummary,
} from "@wa/protocol";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, listModelIds } from "../agent/model.ts";
import { type Env, maxConcurrentTurns } from "../env.ts";
import { toHistoryMessages } from "./history.ts";
import { OpRpc } from "./op-rpc.ts";
import { Outbox } from "./outbox.ts";
import { SessionRunner } from "./session-runner.ts";
import { SessionStore, toSummary } from "./session-store.ts";

interface SocketState {
	cwd: string;
	sessions: string[];
}

/** Heartbeat that keeps the DO resident while a turn awaits a remote tool. */
const KEEPALIVE_INTERVAL_MS = 10_000;
const MAX_INBOUND_MESSAGE_BYTES = 1_000_000;

/**
 * One Durable Object per user. Owns that user's sessions, their SQLite entry
 * log, and every live WebSocket the user has open.
 *
 * All in-memory fields are rebuilt on demand: the DO is evicted whenever it
 * goes idle, and its constructor runs again on the next event.
 */
export class UserAgentDO extends DurableObject<Env> {
	private readonly store: SessionStore;
	private readonly outbox: Outbox;
	private readonly rpc: OpRpc;
	private readonly runners = new Map<string, SessionRunner>();
	private modelRuntime: Promise<ModelRuntime> | undefined;
	private keepalive: ReturnType<typeof setInterval> | undefined;
	private activeTurns = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.store = new SessionStore(ctx.storage.sql);
		this.outbox = new Outbox((message) => {
			if (message.t === "stream") this.broadcast(message.sessionId, message);
		});
		this.rpc = new OpRpc({
			send: (message) => {
				if (message.t === "op.call") {
					const owner = this.ownerFor(message.sessionId);
					if (!owner) return false;
					return this.sendTo(owner, message);
				}
				// op.abort has no session context; unknown call ids are ignored by clients.
				for (const socket of this.ctx.getWebSockets()) this.sendTo(socket, message);
				return true;
			},
		});
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const userId = url.searchParams.get("uid");
		if (!userId) return new Response("unresolved user", { status: 401 });

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
		this.ctx.acceptWebSocket(server);
		this.setState(server, { cwd: "/", sessions: [] });

		this.sendTo(server, {
			t: "ready",
			protocolVersion: PROTOCOL_VERSION,
			userId,
			sessions: this.summaries(),
			maxConcurrentTurns: maxConcurrentTurns(this.env),
		});

		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		if (typeof raw !== "string") return;
		if (raw.length > MAX_INBOUND_MESSAGE_BYTES) {
			this.sendTo(ws, { t: "fatal", message: "message too large" });
			return;
		}

		let message: unknown;
		try {
			message = JSON.parse(raw);
		} catch {
			this.sendTo(ws, { t: "fatal", message: "invalid JSON" });
			return;
		}
		if (!isClientMessage(message)) {
			this.sendTo(ws, { t: "fatal", message: "unrecognised message" });
			return;
		}

		try {
			await this.dispatch(ws, message);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			const id = (message as { id?: string }).id;
			if (id) this.sendTo(ws, { t: "ack", id, ok: false, error: text });
			else this.sendTo(ws, { t: "fatal", message: text });
		}
	}

	override async webSocketClose(ws: WebSocket): Promise<void> {
		this.releaseSocket(ws);
	}

	override async webSocketError(ws: WebSocket): Promise<void> {
		this.releaseSocket(ws);
	}

	// -------------------------------------------------------------------------

	private async dispatch(ws: WebSocket, message: ClientMessage): Promise<void> {
		switch (message.t) {
			case "hello": {
				if (message.protocolVersion !== PROTOCOL_VERSION) {
					this.sendTo(ws, {
						t: "fatal",
						message: `protocol mismatch: server ${PROTOCOL_VERSION}, client ${message.protocolVersion}`,
					});
					return;
				}
				const state = this.getState(ws);
				this.setState(ws, { ...state, cwd: message.cwd });
				return;
			}

			case "ping":
				this.sendTo(ws, { t: "ack", id: message.id, ok: true });
				return;

			case "session.list":
				this.sendTo(ws, { t: "ack", id: message.id, ok: true, data: { sessions: this.summaries() } });
				return;

			case "session.create": {
				const state = this.getState(ws);
				const cwd = message.cwd ?? state.cwd;
				const sessionId = crypto.randomUUID();
				const row = this.store.createSession(sessionId, cwd, message.title ?? null);
				this.attach(ws, sessionId);
				this.sendTo(ws, {
					t: "ack",
					id: message.id,
					ok: true,
					data: { session: toSummary(row, false), models: listModelIds() },
				});
				return;
			}

			case "session.attach": {
				const row = this.store.getSession(message.sessionId);
				if (!row) throw new Error(`unknown session ${message.sessionId}`);
				this.attach(ws, message.sessionId);
				// Ack first so the client can announce the session before the transcript.
				this.sendTo(ws, {
					t: "ack",
					id: message.id,
					ok: true,
					data: { session: toSummary(row, this.runners.get(message.sessionId)?.running ?? false) },
				});
				const entries = this.store.readEntries(message.sessionId, message.sinceSeq ?? 0);
				this.sendTo(ws, {
					t: "history",
					sessionId: message.sessionId,
					messages: toHistoryMessages(entries),
					lastSeq: this.store.lastSeq(message.sessionId),
				});
				return;
			}

			case "session.detach":
				this.detach(ws, message.sessionId);
				this.sendTo(ws, { t: "ack", id: message.id, ok: true });
				return;

			case "session.delete": {
				const runner = this.runners.get(message.sessionId);
				if (runner?.running) throw new Error("cannot delete a session while it is streaming");
				runner?.dispose();
				this.runners.delete(message.sessionId);
				this.store.deleteSession(message.sessionId);
				for (const socket of this.ctx.getWebSockets()) this.detach(socket, message.sessionId);
				this.sendTo(ws, { t: "ack", id: message.id, ok: true });
				return;
			}

			case "prompt": {
				const runner = await this.runnerFor(message.sessionId, ws);
				if (!runner.running && this.activeTurns >= maxConcurrentTurns(this.env)) {
					throw new Error(`concurrency limit reached (${maxConcurrentTurns(this.env)} sessions streaming)`);
				}
				this.attach(ws, message.sessionId);
				// Acknowledge acceptance, then run the turn detached so this handler
				// returns and subsequent frames (tool results, abort) keep flowing.
				this.sendTo(ws, { t: "ack", id: message.id, ok: true });
				this.startTurn(runner, message.text, message.streamingBehavior);
				return;
			}

			case "abort": {
				const runner = this.runners.get(message.sessionId);
				if (runner) await runner.abort();
				this.sendTo(ws, { t: "ack", id: message.id, ok: true });
				return;
			}

			case "op.result":
				if (message.ok) this.rpc.resolve(message.callId, message.result);
				else this.rpc.reject(message.callId, message.error);
				return;

			case "op.update":
				this.rpc.update(message.callId, base64ToBytes(message.base64));
				return;

			default: {
				const exhaustive: never = message;
				throw new Error(`unhandled message ${JSON.stringify(exhaustive)}`);
			}
		}
	}

	private startTurn(runner: SessionRunner, text: string, streamingBehavior?: "steer" | "followUp"): void {
		this.activeTurns += 1;
		this.armKeepalive();
		void runner
			.prompt(text, streamingBehavior)
			.catch((error: unknown) => {
				this.outbox.pushAndFlush(runner.sessionId, {
					k: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				this.activeTurns = Math.max(0, this.activeTurns - 1);
				this.outbox.flush();
				this.notifySessionUpdated(runner.sessionId);
				if (this.activeTurns === 0) this.clearKeepalive();
			});
	}

	private async runnerFor(sessionId: string, ws: WebSocket): Promise<SessionRunner> {
		const existing = this.runners.get(sessionId);
		if (existing) return existing;

		const row = this.store.getSession(sessionId);
		if (!row) throw new Error(`unknown session ${sessionId}`);

		this.modelRuntime ??= createModelRuntime(this.env);
		const runner = await SessionRunner.open({
			env: this.env,
			modelRuntime: await this.modelRuntime,
			rpc: this.rpc,
			store: this.store,
			outbox: this.outbox,
			sessionId,
			cwd: row.cwd || this.getState(ws).cwd,
		});
		this.runners.set(sessionId, runner);
		return runner;
	}

	// --- socket bookkeeping --------------------------------------------------

	private getState(ws: WebSocket): SocketState {
		const raw = ws.deserializeAttachment() as SocketState | null;
		return raw ?? { cwd: "/", sessions: [] };
	}

	private setState(ws: WebSocket, state: SocketState): void {
		ws.serializeAttachment(state);
	}

	private attach(ws: WebSocket, sessionId: string): void {
		const state = this.getState(ws);
		if (!state.sessions.includes(sessionId)) {
			this.setState(ws, { ...state, sessions: [...state.sessions, sessionId] });
		}
	}

	private detach(ws: WebSocket, sessionId: string): void {
		const state = this.getState(ws);
		if (state.sessions.includes(sessionId)) {
			this.setState(ws, { ...state, sessions: state.sessions.filter((id) => id !== sessionId) });
		}
	}

	/** The socket responsible for executing this session's tools. */
	private ownerFor(sessionId: string): WebSocket | undefined {
		for (const socket of this.ctx.getWebSockets()) {
			if (this.getState(socket).sessions.includes(sessionId)) return socket;
		}
		return undefined;
	}

	private broadcast(sessionId: string, message: ServerMessage): void {
		for (const socket of this.ctx.getWebSockets()) {
			if (this.getState(socket).sessions.includes(sessionId)) this.sendTo(socket, message);
		}
	}

	private sendTo(ws: WebSocket, message: ServerMessage): boolean {
		try {
			ws.send(JSON.stringify(message));
			return true;
		} catch {
			return false;
		}
	}

	private releaseSocket(ws: WebSocket): void {
		const state = this.getState(ws);
		// Any tool call routed to this socket can no longer be answered.
		const orphaned = state.sessions.filter((id) => !this.ownerForExcluding(id, ws));
		if (orphaned.length > 0) {
			this.rpc.rejectAll("client disconnected before the tool call completed");
		}
		this.setState(ws, { ...state, sessions: [] });
	}

	private ownerForExcluding(sessionId: string, exclude: WebSocket): WebSocket | undefined {
		for (const socket of this.ctx.getWebSockets()) {
			if (socket === exclude) continue;
			if (this.getState(socket).sessions.includes(sessionId)) return socket;
		}
		return undefined;
	}

	private notifySessionUpdated(sessionId: string): void {
		const row = this.store.getSession(sessionId);
		if (!row) return;
		this.broadcast(sessionId, {
			t: "session.updated",
			session: toSummary(row, this.runners.get(sessionId)?.running ?? false),
		});
	}

	private summaries(): SessionSummary[] {
		return this.store.listSessions().map((row) => toSummary(row, this.runners.get(row.sessionId)?.running ?? false));
	}

	private armKeepalive(): void {
		// A pending promise alone does not stop hibernation, but a live timer does.
		this.keepalive ??= setInterval(() => {}, KEEPALIVE_INTERVAL_MS);
	}

	private clearKeepalive(): void {
		if (this.keepalive === undefined) return;
		clearInterval(this.keepalive);
		this.keepalive = undefined;
	}
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
