import type { RemoteOpArgs, RemoteOpName, RemoteOpResult, ServerMessage } from "@wa/protocol";

/**
 * Request/response bridge for tools that execute on the connected client.
 *
 * The agent runs on Cloudflare, which has no process or filesystem, so pi's
 * pluggable `*Operations` interfaces are remoted over the WebSocket. Every call
 * is bounded by a timeout and cancellable, because a hung client would
 * otherwise pin a turn open forever.
 */

export const DEFAULT_OP_TIMEOUT_MS = 60_000;
export const DEFAULT_BASH_TIMEOUT_MS = 10 * 60_000;

export class RemoteOpError extends Error {}

interface PendingOp {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	onUpdate?: (chunk: Uint8Array) => void;
	timer: ReturnType<typeof setTimeout>;
	detach: () => void;
	op: string;
	startedAt: number;
}

export interface OpTransport {
	/** Returns false when no client socket can currently serve this session. */
	send(message: ServerMessage): boolean;
}

export class OpRpc {
	private readonly transport: OpTransport;
	private readonly pending = new Map<string, PendingOp>();
	private counter = 0;

	constructor(transport: OpTransport) {
		this.transport = transport;
	}

	get inFlight(): number {
		return this.pending.size;
	}

	call<K extends RemoteOpName>(params: {
		op: K;
		args: RemoteOpArgs<K>;
		sessionId: string;
		signal?: AbortSignal;
		onUpdate?: (chunk: Uint8Array) => void;
		timeoutMs?: number;
	}): Promise<RemoteOpResult<K>> {
		const { op, args, sessionId, signal, onUpdate } = params;
		const timeoutMs = params.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS;

		if (signal?.aborted) {
			return Promise.reject(new RemoteOpError("aborted"));
		}

		const callId = `op-${++this.counter}-${Date.now().toString(36)}`;

		return new Promise<RemoteOpResult<K>>((resolve, reject) => {
			const onAbort = () => {
				this.transport.send({ t: "op.abort", callId });
				this.settleWith(callId, () => reject(new RemoteOpError("aborted")));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const timer = setTimeout(() => {
				this.transport.send({ t: "op.abort", callId });
				this.settleWith(callId, () => reject(new RemoteOpError(`client did not answer ${op} within ${timeoutMs}ms`)));
			}, timeoutMs);

			this.pending.set(callId, {
				resolve: resolve as (value: unknown) => void,
				reject,
				onUpdate,
				timer,
				detach: () => signal?.removeEventListener("abort", onAbort),
				op,
				startedAt: Date.now(),
			});

			const delivered = this.transport.send({
				t: "op.call",
				callId,
				sessionId,
				op,
				args: args as RemoteOpArgs,
				timeoutMs,
			});
			if (!delivered) {
				this.settleWith(callId, () => reject(new RemoteOpError("no client connected to execute tools")));
			}
		});
	}

	/** Streamed partial output (for example bash stdout) for an in-flight call. */
	update(callId: string, chunk: Uint8Array): void {
		this.pending.get(callId)?.onUpdate?.(chunk);
	}

	resolve(callId: string, result: unknown): void {
		const entry = this.pending.get(callId);
		if (!entry) return;
		this.settleWith(callId, () => entry.resolve(result));
	}

	reject(callId: string, message: string): void {
		const entry = this.pending.get(callId);
		if (!entry) return;
		this.settleWith(callId, () => entry.reject(new RemoteOpError(message)));
	}

	/** Fails every in-flight call, for example when the owning socket drops. */
	rejectAll(message: string): void {
		for (const callId of [...this.pending.keys()]) {
			this.reject(callId, message);
		}
	}

	private settleWith(callId: string, settle: () => void): void {
		const entry = this.pending.get(callId);
		if (!entry) return;
		this.pending.delete(callId);
		clearTimeout(entry.timer);
		entry.detach();
		// Round-trip as seen by the DO: serialise + WS + client work + WS back.
		// Compare against the tool-level timing to isolate transport overhead.
		console.log(`[timing] rpc ${entry.op} ${Date.now() - entry.startedAt}ms`);
		settle();
	}
}
