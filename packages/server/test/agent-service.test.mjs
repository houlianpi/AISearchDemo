import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_THINKING_LEVEL, AgentService, SYSTEM_PROMPT } from "../src/local/agent-service.ts";

test("uses low thinking and permits one lightweight search retry", () => {
	assert.equal(AGENT_THINKING_LEVEL, "low");
	assert.match(SYSTEM_PROMPT, /one primary web_search call/i);
	assert.match(SYSTEM_PROMPT, /exactly one concise query using the query field/i);
	assert.match(SYSTEM_PROMPT, /workflow to "none"/i);
	assert.match(SYSTEM_PROMPT, /includeContent to false/i);
	assert.match(SYSTEM_PROMPT, /Never use the queries field/i);
	assert.match(SYSTEM_PROMPT, /Only when the primary search returns an error or zero results/i);
	assert.match(SYSTEM_PROMPT, /Never make more than two web_search calls total/i);
	assert.match(SYSTEM_PROMPT, /Keep links and source lists out of the answer/i);
});

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
