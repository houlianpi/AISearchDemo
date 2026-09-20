import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRemoteSession } from "../src/agent/session-factory.ts";
import {
	activeProviderId,
	createModelRuntime,
	defaultThinkingLevel,
	listModelIds,
	resolveModel,
	resolveRestoredModel,
} from "../src/agent/model.ts";

const copilot = {
	LLM_PROVIDER: "copilot",
	COPILOT_BASE_URL: "https://example.invalid/v1",
	COPILOT_API_KEY: "test-key",
	COPILOT_DEFAULT_MODEL: "gpt-5.6-sol",
};

test("copilot supports GPT-5.6 SOL with independent credentials and model selection", async () => {
	const runtime = await createModelRuntime(copilot);
	const model = resolveModel(runtime, copilot);
	assert.equal(activeProviderId(copilot), "copilot");
	assert.deepEqual(listModelIds(copilot), ["gpt-5.6-sol", "gemini-3.8-flash"]);
	assert.equal(model.provider, "copilot");
	assert.equal(model.id, "gpt-5.6-sol");
	assert.equal(model.baseUrl, copilot.COPILOT_BASE_URL);
	assert.equal(model.api, "openai-completions");
	assert.equal(model.maxTokens, 32000);
	assert.equal(model.contextWindow, 200000);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(defaultThinkingLevel(copilot), "medium");
	assert.equal(defaultThinkingLevel({ ...copilot, COPILOT_DEFAULT_MODEL: " " }), "medium");
	assert.equal(resolveModel(runtime, { ...copilot, COPILOT_DEFAULT_MODEL: undefined }).id, "gpt-5.6-sol");
	assert.equal(resolveRestoredModel(runtime, copilot, { provider: "deepseek", modelId: "deepseek-v4-flash" }).id, "gpt-5.6-sol");
	assert.throws(() => resolveModel(runtime, copilot, "not-a-model"), /unknown model/);
});

test("Gemini uses the same provider and credentials while restored GPT sessions retain their model", async () => {
	const env = { ...copilot, COPILOT_DEFAULT_MODEL: "gemini-3.8-flash" };
	const runtime = await createModelRuntime(env);
	const model = resolveModel(runtime, env);
	assert.equal(model.id, "gemini-3.8-flash");
	assert.equal(model.provider, "copilot");
	assert.equal(model.baseUrl, copilot.COPILOT_BASE_URL);
	assert.equal(model.api, "openai-completions");
	assert.equal(model.contextWindow, 983040);
	assert.equal(model.maxTokens, 65536);
	assert.equal(defaultThinkingLevel(env), undefined);
	assert.equal(defaultThinkingLevel(env, "gpt-5.6-sol"), "medium");
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(resolveRestoredModel(runtime, env, { provider: "copilot", modelId: "gpt-5.6-sol" }).id, "gpt-5.6-sol");
	assert.equal(resolveRestoredModel(runtime, env, { provider: "deepseek", modelId: "deepseek-v4-flash" }).id, "gemini-3.8-flash");
});

test("missing copilot credentials fail explicitly without requiring unused provider keys", async () => {
	await assert.rejects(createModelRuntime({ ...copilot, COPILOT_API_KEY: undefined }), /COPILOT_API_KEY/);
	await assert.rejects(createModelRuntime({ ...copilot, COPILOT_BASE_URL: undefined }), /base URL is not configured/);
});

test("gateway and deepseek remain independent with their configured defaults", async () => {
	const gateway = { LLM_BASE_URL: "https://example.invalid/v1", LLM_API_KEY: "test-key", DEFAULT_MODEL: "claude-opus-4.8" };
	assert.equal(activeProviderId(gateway), "gateway");
	assert.equal(resolveModel(await createModelRuntime(gateway), gateway).id, "claude-opus-4.8");
	assert.ok(listModelIds(gateway).includes("gpt-5.6-sol"));
	assert.equal(defaultThinkingLevel(gateway, "gpt-5.6-sol"), undefined);
	const deepseek = {
		LLM_PROVIDER: "deepseek", DEEPSEEK_BASE_URL: "https://example.invalid/v1",
		DEEPSEEK_API_KEY: "test-key", DEEPSEEK_DEFAULT_MODEL: "deepseek-v4-flash",
	};
	const runtime = await createModelRuntime(deepseek);
	const model = resolveModel(runtime, deepseek);
	assert.equal(model.id, "deepseek-v4-flash");
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(resolveModel(runtime, deepseek, "deepseek-v4-pro").input, ["text"]);
	assert.equal(defaultThinkingLevel(deepseek), "medium");
	let payload;
	const stream = await runtime.streamSimple(model, {
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
	}, {
		reasoning: defaultThinkingLevel(deepseek, model.id),
		onPayload: (body) => { payload = body; throw new Error("OFFLINE_CAPTURE"); },
	});
	assert.match((await stream.result()).errorMessage, /OFFLINE_CAPTURE/);
	assert.equal(payload.reasoning_effort, "medium");
	assert.deepEqual(payload.thinking, { type: "enabled" });
});

test("copilot SDK serializes the expected model, system role and reasoning without network access", async (t) => {
	const fetchMock = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
	const runtime = await createModelRuntime(copilot);
	for (const id of listModelIds(copilot)) {
		const model = resolveModel(runtime, copilot, id);
		const reasoning = defaultThinkingLevel(copilot, id) ?? "medium";
		let payload;
		const stream = await runtime.streamSimple(model, {
			systemPrompt: "Return OK.",
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		}, {
			reasoning,
			onPayload: (body) => { payload = body; throw new Error("OFFLINE_CAPTURE"); },
		});
		assert.match((await stream.result()).errorMessage, /OFFLINE_CAPTURE/);
		assert.equal(payload.model, id);
		assert.equal(payload.messages[0].role, "system");
		assert.equal(payload.reasoning_effort, reasoning);
		assert.equal(payload.max_completion_tokens, model.maxTokens);
		assert.equal(payload.stream, true);
	}
	assert.equal(fetchMock.mock.callCount(), 0);
});

test("new GPT sessions use medium while Gemini and persisted session levels are preserved", async (t) => {
	const env = { ...copilot, COPILOT_DEFAULT_MODEL: "gemini-3.8-flash" };
	const runtime = await createModelRuntime(env);
	const open = async (options) => {
		const result = await createRemoteSession({
			env, modelRuntime: runtime, sessionId: "reasoning-test",
			rpc: { call: () => assert.fail("No IO is required to create a session") }, ...options,
		});
		t.after(() => result.session.dispose());
		return result.session;
	};
	assert.equal((await open({ modelId: "gpt-5.6-sol" })).thinkingLevel, "medium");
	assert.equal((await open({})).thinkingLevel, "medium");
	const manager = SessionManager.inMemory("/workspace");
	manager.appendModelChange("copilot", "gpt-5.6-sol");
	manager.appendThinkingLevelChange("low");
	const history = manager.getEntries().map((entry, seq) => ({ seq, entryId: entry.id, type: entry.type, entry }));
	assert.equal((await open({ history })).thinkingLevel, "low");
});
