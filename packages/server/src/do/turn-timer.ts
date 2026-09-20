import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

/** Counts provider streams, including pre-header waiting, rather than agent message events. */
export class TurnTimer {
	private readonly sessionId: string;
	private readonly startedAt = Date.now();
	private llmWall = 0;
	private llmDepth = 0;
	private llmSpanStart = 0;
	private llmCalls = 0;
	private toolWall = 0;
	private toolDepth = 0;
	private toolSpanStart = 0;
	private firstTokenAt: number | undefined;
	private readonly openTools = new Map<string, number>();
	private readonly byTool = new Map<string, { calls: number; ms: number }>();

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	stream(streamFn: StreamFn, ...[model, context, options]: Parameters<StreamFn>): ReturnType<StreamFn> {
		const start = Date.now();
		if (this.llmDepth++ === 0) this.llmSpanStart = start;
		const label = `${this.sessionId} llm#${++this.llmCalls}`;
		const output = createAssistantMessageEventStream();
		let headersAt: number | undefined;
		let status: number | undefined;
		let firstDelta: number | undefined;
		let lastDelta: number | undefined;
		let maxGap = 0;
		let thinkChars = 0;
		let textChars = 0;
		let argsChars = 0;
		let finished = false;
		let partial: AssistantMessage = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			timestamp: start, stopReason: "error",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		console.log(
			`[timing] ${label} begin provider=${model.provider} model=${model.id}` +
				` thinkingLevel=${options?.reasoning ?? "unset"}`,
		);

		const finish = (message: AssistantMessage) => {
			if (finished) return;
			finished = true;
			const now = Date.now();
			if (--this.llmDepth === 0) this.llmWall += now - this.llmSpanStart;
			const usage = message.usage;
			const known = usage.totalTokens > 0 || usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
			// pi's OpenAI adapter normalizes missing reasoning_tokens to zero.
			const reasoning = usage.reasoning === undefined ? "unreported"
				: usage.reasoning === 0 ? "0-or-unreported" : usage.reasoning;
			console.log(
				`[timing] ${label} ${now - start}ms stop=${message.stopReason}` +
					` headers=${headersAt === undefined ? "?" : `${headersAt - start}ms`} status=${status ?? "?"}` +
					` ttft=${firstDelta === undefined ? "?" : `${firstDelta - start}ms`}` +
					` stream=${firstDelta === undefined ? 0 : now - firstDelta}ms maxGap=${maxGap}ms` +
					` think=${thinkChars}ch text=${textChars}ch args=${argsChars}ch` +
					` promptTokens=${known ? usage.input + usage.cacheRead + usage.cacheWrite : "?"}` +
					` outputTokens=${known ? usage.output : "?"} reasoningTokens=${reasoning}` +
					` cacheRead=${known ? usage.cacheRead : "?"} cacheWrite=${known ? usage.cacheWrite : "?"}` +
					` totalTokens=${known ? usage.totalTokens : "?"}`,
			);
		};

		void (async () => {
			try {
				const source = await streamFn(model, context, {
					...options,
					onPayload: async (payload, requestModel) => {
						const replacement = await options?.onPayload?.(payload, requestModel);
						const body = record(replacement === undefined ? payload : replacement);
						// Log only scalar settings, never payload contents, credentials or headers.
						console.log(
							`[timing] ${label} request model=${setting(body.model)}` +
								` reasoning_effort=${setting(body.reasoning_effort)}` +
								` thinking=${setting(record(body.thinking).type)}` +
								` max_tokens=${setting(body.max_tokens)}` +
								` max_completion_tokens=${setting(body.max_completion_tokens)}`,
						);
						return replacement;
					},
					onResponse: async (response, requestModel) => {
						headersAt = Date.now();
						status = response.status;
						console.log(`[timing] ${label} headers=${headersAt - start}ms status=${status}`);
						await options?.onResponse?.(response, requestModel);
					},
				});
				for await (const event of source) {
					if ("partial" in event) partial = event.partial;
					if (event.type === "done" || event.type === "error") {
						partial = event.type === "done" ? event.message : event.error;
						finish(partial);
					} else if (
						(event.type === "thinking_delta" || event.type === "text_delta" || event.type === "toolcall_delta") &&
						event.delta.length > 0
					) {
						const now = Date.now();
						this.firstTokenAt ??= now;
						firstDelta ??= now;
						if (lastDelta !== undefined) maxGap = Math.max(maxGap, now - lastDelta);
						lastDelta = now;
						if (event.type === "thinking_delta") thinkChars += event.delta.length;
						else if (event.type === "text_delta") textChars += event.delta.length;
						else argsChars += event.delta.length;
					}
					output.push(event);
				}
				const final = await source.result();
				finish(final);
				output.end(final);
			} catch (error) {
				// Preserve the StreamFn contract even for failures before an SSE start event.
				const reason = options?.signal?.aborted ? "aborted" : "error";
				const failure: AssistantMessage = {
					...partial, stopReason: reason,
					errorMessage: error instanceof Error ? error.message : String(error),
				};
				finish(failure);
				output.push({ type: "error", reason, error: failure });
				output.end(failure);
			}
		})();
		return output;
	}

	toolStart(callId: string, _name: string): void {
		const now = Date.now();
		if (this.toolDepth++ === 0) this.toolSpanStart = now;
		this.openTools.set(callId, now);
	}

	toolEnd(callId: string, name: string, isError: boolean): void {
		const start = this.openTools.get(callId);
		if (start === undefined) return;
		this.openTools.delete(callId);
		const now = Date.now();
		if (--this.toolDepth === 0) this.toolWall += now - this.toolSpanStart;
		const ms = now - start;
		const bucket = this.byTool.get(name) ?? { calls: 0, ms: 0 };
		bucket.calls++;
		bucket.ms += ms;
		this.byTool.set(name, bucket);
		console.log(`[timing] ${this.sessionId} tool ${name} ${ms}ms${isError ? " ERROR" : ""}`);
	}

	report(): void {
		const now = Date.now();
		const total = now - this.startedAt;
		const llm = this.llmWall + (this.llmDepth > 0 ? now - this.llmSpanStart : 0);
		const tools = this.toolWall + (this.toolDepth > 0 ? now - this.toolSpanStart : 0);
		const other = Math.max(0, total - llm - tools);
		const breakdown = [...this.byTool.entries()]
			.sort((a, b) => b[1].ms - a[1].ms)
			.map(([name, value]) => `${name}×${value.calls}=${value.ms}ms`).join(" ");
		console.log(
			`[timing] ${this.sessionId} TURN total=${total}ms` +
				` llm=${llm}ms(${pct(llm, total)}) tools=${tools}ms(${pct(tools, total)}) other=${other}ms` +
				` ttft=${this.firstTokenAt === undefined ? "?" : `${this.firstTokenAt - this.startedAt}ms`}` +
				` llmCalls=${this.llmCalls}` + (breakdown ? ` | ${breakdown}` : ""),
		);
	}
}

function pct(part: number, total: number): string {
	return `${(total > 0 ? part / total * 100 : 0).toFixed(1)}%`;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function setting(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return typeof value === "string" && /^[\w./:-]{1,100}$/.test(value) ? value : "?";
}
