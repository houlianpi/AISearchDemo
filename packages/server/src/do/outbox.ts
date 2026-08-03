import type { AgentStreamEvent, ServerMessage } from "@wa/protocol";

/**
 * Coalesces agent stream events into a small number of WebSocket frames.
 *
 * Sending one frame per token would dominate the Durable Object's time with
 * context switches; Cloudflare explicitly recommends batching. The timer is
 * only armed while events are queued so an idle DO can still hibernate.
 */
export class Outbox {
	private readonly send: (message: ServerMessage) => void;
	private readonly flushMs: number;
	private readonly maxChars: number;
	private readonly queues = new Map<string, AgentStreamEvent[]>();
	private queuedChars = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(send: (message: ServerMessage) => void, flushMs = 40, maxChars = 32_000) {
		this.send = send;
		this.flushMs = flushMs;
		this.maxChars = maxChars;
	}

	push(sessionId: string, event: AgentStreamEvent): void {
		const queue = this.queues.get(sessionId);
		if (queue) {
			const last = queue[queue.length - 1];
			// Merge consecutive text deltas so a long answer costs one array slot.
			if (last && (last.k === "text_delta" || last.k === "thinking_delta") && last.k === event.k) {
				last.text += (event as { text: string }).text;
			} else {
				queue.push(event);
			}
		} else {
			this.queues.set(sessionId, [event]);
		}

		this.queuedChars += estimateSize(event);
		if (this.queuedChars >= this.maxChars) {
			this.flush();
			return;
		}
		if (!this.timer) {
			this.timer = setTimeout(() => this.flush(), this.flushMs);
		}
	}

	/** Flushes queued events and, for terminal events, sends immediately. */
	pushAndFlush(sessionId: string, event: AgentStreamEvent): void {
		this.push(sessionId, event);
		this.flush();
	}

	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.queues.size === 0) return;
		const snapshot = [...this.queues.entries()];
		this.queues.clear();
		this.queuedChars = 0;
		for (const [sessionId, events] of snapshot) {
			if (events.length > 0) this.send({ t: "stream", sessionId, events });
		}
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.queues.clear();
		this.queuedChars = 0;
	}
}

function estimateSize(event: AgentStreamEvent): number {
	if (event.k === "text_delta" || event.k === "thinking_delta") return event.text.length;
	if (event.k === "tool_update") return event.text.length;
	if (event.k === "tool_end") return event.output.length;
	return 64;
}
