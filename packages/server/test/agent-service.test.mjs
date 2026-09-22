import assert from "node:assert/strict";
import test from "node:test";
import { AgentService } from "../src/local/agent-service.ts";

test("requires a non-empty prompt before initializing the model runtime", async () => {
	let runtimeCreated = false;
	const service = new AgentService({
		runtimeFactory: async () => { runtimeCreated = true; throw new Error("must not run"); },
	});
	await assert.rejects(() => service.message("demo", { prompt: "   " }), { status: 400, code: "INVALID_PROMPT" });
	assert.equal(runtimeCreated, false);
});

test("validates session identifiers", async () => {
	const service = new AgentService({ runtimeFactory: async () => { throw new Error("must not run"); } });
	await assert.rejects(() => service.message("bad/session", { prompt: "hello" }), { status: 400, code: "INVALID_SESSION_ID" });
});
