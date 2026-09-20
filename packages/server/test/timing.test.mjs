import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { TurnTimer } from "../src/do/turn-timer.ts";
import { SessionRunner } from "../src/do/session-runner.ts";
import { createModelRuntime } from "../src/agent/model.ts";

const model = { id: "gpt-5.6-sol", provider: "copilot", api: "openai-completions" };
const context = { messages: [{ role: "user", content: "PRIVATE_PROMPT", timestamp: 0 }] };

function message(overrides = {}) {
	return {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		timestamp: 0, stopReason: "stop",
		usage: {
			input: 1000, output: 24552, reasoning: 22709, cacheRead: 19000, cacheWrite: 0, totalTokens: 44552,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...overrides,
	};
}

function capture(t) {
	const lines = [];
	t.mock.method(console, "log", (line) => lines.push(line));
	return lines;
}

test("provider timing includes pre-header waiting and distinguishes buffered arguments from token speed", async (t) => {
	const lines = capture(t);
	let now = 1000;
	t.mock.method(Date, "now", () => now);
	const timer = new TurnTimer("timing-test");
	const final = message();
	let observedPayload;
	let responses = 0;
	const source = (_model, _context, options) => ({
		async *[Symbol.asyncIterator]() {
			now = 1010;
			observedPayload = await options.onPayload({
				model: model.id, reasoning_effort: "medium", max_completion_tokens: 32000,
				messages: context.messages, apiKey: "PRIVATE_KEY",
			}, model);
			now = 3000;
			await options.onResponse({ status: 200, headers: { authorization: "PRIVATE_HEADER" } }, model);
			yield { type: "start", partial: final };
			yield { type: "text_delta", delta: "", contentIndex: 0, partial: final };
			now = 5000;
			yield { type: "toolcall_delta", delta: "x".repeat(17505), contentIndex: 0, partial: final };
			now = 5004;
			yield { type: "done", reason: "stop", message: final };
		},
		async result() { return final; },
	});
	const stream = await timer.stream(source, model, context, {
		reasoning: "low",
		onPayload: (payload) => ({ ...payload, reasoning_effort: "low" }),
		onResponse: () => { responses++; },
	});
	const events = [];
	for await (const event of stream) events.push(event);
	assert.equal(await stream.result(), final);
	assert.equal(events.length, 4);
	assert.equal(observedPayload.reasoning_effort, "low");
	assert.equal(responses, 1);
	now = 5010; timer.toolStart("t1", "write");
	now = 5015; timer.toolStart("t2", "write");
	now = 5030; timer.toolEnd("t1", "write", false);
	now = 5040; timer.toolEnd("t2", "write", false);
	now = 5054; timer.report();
	const log = lines.join("\n");
	assert.match(log, /request model=gpt-5.6-sol reasoning_effort=low/);
	assert.match(log, /4004ms stop=stop headers=2000ms status=200 ttft=4000ms stream=4ms/);
	assert.match(log, /think=0ch text=0ch args=17505ch promptTokens=20000 outputTokens=24552 reasoningTokens=22709/);
	assert.match(log, /TURN total=4054ms llm=4004ms.*tools=30ms.*other=20ms.*llmCalls=1/);
	assert.doesNotMatch(log, /PRIVATE_|tok\/s|prefill=/);
});

test("unknown and normalized-zero reasoning usage are not claimed to mean no thinking", async (t) => {
	const lines = capture(t);
	for (const reasoning of [undefined, 0]) {
		const final = message();
		final.usage.reasoning = reasoning;
		const timer = new TurnTimer("reasoning");
		const stream = await timer.stream(() => ({
			async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message: final }; },
			async result() { return final; },
		}), model, context);
		assert.equal(await stream.result(), final);
		timer.report();
	}
	assert.match(lines.join("\n"), /reasoningTokens=unreported/);
	assert.match(lines.join("\n"), /reasoningTokens=0-or-unreported/);
	assert.doesNotMatch(lines.join("\n"), /reasoningTokens=0(?:\s|$)/);
});

test("request failures and aborts complete the stream and accounting even before an SSE start", async (t) => {
	const lines = capture(t);
	for (const aborted of [false, true]) {
		const timer = new TurnTimer("failed");
		const controller = new AbortController();
		if (aborted) controller.abort();
		const stream = await timer.stream(() => { throw new Error("provider unavailable"); }, model, context, {
			signal: controller.signal,
		});
		const result = await stream.result();
		assert.equal(result.stopReason, aborted ? "aborted" : "error");
		assert.equal(result.errorMessage, "provider unavailable");
		timer.report();
	}
	assert.equal(lines.filter((line) => line.includes("TURN") && line.includes("llmCalls=1")).length, 2);
	assert.match(lines.join("\n"), /headers=\? status=\? ttft=\? stream=0ms/);
});

test("protocol errors retain partial output and do not get counted twice", async (t) => {
	const lines = capture(t);
	const final = message({ stopReason: "error", errorMessage: "stream interrupted" });
	const timer = new TurnTimer("partial");
	const stream = await timer.stream(() => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "text_delta", delta: "partial", contentIndex: 0, partial: final };
			yield { type: "error", reason: "error", error: final };
		},
		async result() { return final; },
	}), model, context);
	assert.equal(await stream.result(), final);
	timer.report();
	assert.equal(lines.filter((line) => line.includes("stop=error")).length, 1);
	assert.match(lines.join("\n"), /text=7ch/);
});

test("runner counts real provider calls, not intervening user or tool-result messages", async (t) => {
	const lines = capture(t);
	const env = {
		LLM_PROVIDER: "copilot", COPILOT_BASE_URL: "https://example.invalid/v1",
		COPILOT_API_KEY: "test-key", COPILOT_DEFAULT_MODEL: "gpt-5.6-sol",
	};
	const runtime = await createModelRuntime(env);
	let calls = 0;
	t.mock.method(runtime, "streamSimple", (_model, _context, options) => {
		assert.equal(options.reasoning, "medium");
		const first = ++calls === 1;
		const final = message({
			content: first
				? [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "ctx.json" } }]
				: [{ type: "text", text: "Done" }],
			stopReason: first ? "toolUse" : "stop",
		});
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: final });
		stream.push({ type: "done", reason: final.stopReason, message: final });
		stream.end(final);
		return stream;
	});
	const bytes = Buffer.from('{"ok":true}');
	const events = [];
	const runner = await SessionRunner.open({
		env, modelRuntime: runtime, sessionId: "runner", cwd: "/workspace",
		rpc: {
			async call({ op }) {
				if (op === "fs.access") return {};
				if (op === "fs.imageMimeType") return { mimeType: null };
				if (op === "fs.readFile") return { base64: bytes.toString("base64"), size: bytes.length };
				throw new Error(`Unexpected operation: ${op}`);
			},
		},
		store: { readEntries: () => [], getSession: () => ({ title: "Fixture" }), appendEntry: () => {} },
		outbox: { push: (_id, event) => events.push(event), pushAndFlush: (_id, event) => events.push(event) },
	});
	t.after(() => runner.dispose());
	await runner.prompt("Read ctx.json.");
	assert.equal(calls, 2);
	assert.equal(events.filter((event) => event.k === "tool_end").length, 1);
	assert.equal(events.filter((event) => event.k === "error").length, 0);
	assert.match(lines.find((line) => line.includes("TURN")), /llmCalls=2/);
	assert.equal(lines.filter((line) => /llm#\d+ \d+ms stop=/.test(line)).length, 2);
	assert.doesNotMatch(lines.join("\n"), /stop=\?/);
});
