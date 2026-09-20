import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { IMAGE_PROMPT_LIMITS } from "@wa/protocol";
import { createModelRuntime } from "../src/agent/model.ts";
import { SessionRunner } from "../src/do/session-runner.ts";
import { MAX_ENTRY_BYTES } from "../src/do/session-store.ts";
import { toHistoryMessages } from "../src/do/history.ts";

const env = {
	LLM_PROVIDER: "deepseek", DEEPSEEK_BASE_URL: "https://example.invalid/v1",
	DEEPSEEK_API_KEY: "test-key", DEEPSEEK_DEFAULT_MODEL: "deepseek-v4-flash",
};
const images = [
	{ mimeType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64") },
	{ mimeType: "image/webp", data: Buffer.from("RIFF0000WEBPfixture").toString("base64") },
];

function finalMessage(model) {
	return {
		role: "assistant", content: [{ type: "text", text: "Seen" }],
		api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
		usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function finish(stream, model) {
	const message = finalMessage(model);
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
}

async function fixture(t, { entries = [], modelId, holdFirst = false } = {}) {
	t.mock.method(console, "log", () => {});
	const network = t.mock.method(globalThis, "fetch", () => assert.fail("No network allowed"));
	const runtime = await createModelRuntime(env);
	const original = runtime.streamSimple.bind(runtime);
	const payloads = [];
	let completeHeld;
	let releaseFirst;
	const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
	t.mock.method(runtime, "streamSimple", async (model, context, options) => {
		const captured = await original(model, context, {
			...options,
			onPayload: async (payload, requestModel) => {
				const replacement = await options?.onPayload?.(payload, requestModel);
				payloads.push(replacement === undefined ? payload : replacement);
				throw new Error("OFFLINE_CAPTURE");
			},
		});
		assert.match((await captured.result()).errorMessage, /OFFLINE_CAPTURE/);
		const stream = createAssistantMessageEventStream();
		if (holdFirst && payloads.length === 1) {
			completeHeld = () => finish(stream, model);
			releaseFirst(completeHeld);
		}
		else finish(stream, model);
		return stream;
	});
	const events = [];
	const store = {
		readEntries: () => entries,
		getSession: () => ({ title: "Fixture" }),
		appendEntry(_sessionId, entryId, type, entry) {
			const json = JSON.stringify(entry);
			assert.ok(Buffer.byteLength(json, "utf8") < MAX_ENTRY_BYTES);
			entries.push({ seq: entries.length + 1, entryId, type, entry: JSON.parse(json) });
		},
	};
	const runner = await SessionRunner.open({
		env, modelRuntime: runtime, modelId, sessionId: "image-session", cwd: "/workspace", store,
		rpc: { call: () => assert.fail("Image prompts must not need file-tool RPC") },
		outbox: { push: (_id, event) => events.push(event), pushAndFlush: (_id, event) => events.push(event) },
	});
	t.after(async () => {
		const aborted = runner.running ? runner.abort() : undefined;
		completeHeld?.();
		await aborted;
		runner.dispose();
		assert.equal(network.mock.callCount(), 0);
	});
	return { runner, entries, payloads, events, firstStarted };
}

function imageUrls(payload) {
	return payload.messages.filter((message) => message.role === "user")
		.flatMap((message) => Array.isArray(message.content) ? message.content : [])
		.filter((part) => part.type === "image_url").map((part) => part.image_url.url);
}

test("multiple images reach the real DeepSeek serializer in order and survive persistence/restore", async (t) => {
	const first = await fixture(t);
	await first.runner.prompt("Compare the images", undefined, images);
	assert.deepEqual(imageUrls(first.payloads[0]), images.map((image) => `data:${image.mimeType};base64,${image.data}`));
	assert.equal(first.events.some((event) => event.k === "error" || event.errorMessage), false);
	const history = toHistoryMessages(first.entries);
	assert.equal(history.find((entry) => entry.k === "user").images.length, 2);
	const restored = await fixture(t, { entries: first.entries });
	await restored.runner.prompt("Describe the first image again");
	assert.deepEqual(imageUrls(restored.payloads[0]), imageUrls(first.payloads[0]));
	const textOnly = await fixture(t, { entries: first.entries, modelId: "deepseek-v4-pro" });
	await assert.rejects(textOnly.runner.prompt("Continue"), /does not support image/);
	assert.equal(textOnly.payloads.length, 0);
});

test("image-only input is not dropped as an empty user message", async (t) => {
	const { runner, entries, payloads } = await fixture(t);
	await runner.prompt("", undefined, images);
	assert.equal(imageUrls(payloads[0]).length, 2);
	const user = toHistoryMessages(entries).find((message) => message.k === "user");
	assert.equal(user.text, "");
	assert.equal(user.images.length, 2);
});

test("a maximum-size attachment plus a substantial caption persists as a full user entry", async (t) => {
	const bytes = Buffer.alloc(IMAGE_PROMPT_LIMITS.maxImageBytes);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
	const large = { mimeType: "image/png", data: bytes.toString("base64") };
	const { runner, entries } = await fixture(t);
	await runner.prompt("x".repeat(150000), undefined, [large]);
	const user = entries.find((row) => row.entry.type === "message" && row.entry.message.role === "user");
	assert.ok(user);
	assert.equal(user.entry.truncated, undefined);
	assert.equal(user.entry.message.content.find((part) => part.type === "image").data.length, large.data.length);
	assert.ok(Buffer.byteLength(JSON.stringify(user.entry), "utf8") < MAX_ENTRY_BYTES);
});

test("text-only models and unsafe persistence sizes fail before any model request", async (t) => {
	const { runner, payloads } = await fixture(t, { modelId: "deepseek-v4-pro" });
	assert.throws(() => runner.validatePrompt("Describe", undefined, images), /does not support image/);
	await assert.rejects(runner.prompt("Describe", undefined, images), /does not support image/);
	assert.equal(payloads.length, 0);
	const capable = await fixture(t);
	await assert.rejects(capable.runner.prompt("x".repeat(MAX_ENTRY_BYTES), undefined, images), /persist safely/);
	assert.equal(capable.payloads.length, 0);
});

test("steered and follow-up image messages retain all attachments while a turn is running", { timeout: 15000 }, async (t) => {
	for (const behavior of ["steer", "followUp"]) {
		const { runner, firstStarted, payloads, events } = await fixture(t, { holdFirst: true });
		const running = runner.prompt("First turn");
		const completeFirst = await firstStarted;
		await runner.prompt("", behavior, images);
		completeFirst();
		await running;
		assert.equal(payloads.length, 2);
		assert.equal(imageUrls(payloads[1]).length, 2);
		assert.equal(events.some((event) => event.k === "error" || event.errorMessage), false);
	}
});
