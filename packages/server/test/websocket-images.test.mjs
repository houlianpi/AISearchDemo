import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { IMAGE_PROMPT_LIMITS, MAX_CLIENT_MESSAGE_BYTES, PROTOCOL_VERSION } from "@wa/protocol";

const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "cloudflare:workers") {
			return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
const { UserAgentDO } = await import("../src/do/user-agent-do.ts");
hooks.deregister();

const image = { mimeType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64") };

function harness(t) {
	const frames = [];
	const calls = [];
	const rpcErrors = [];
	let attachment = { cwd: "/workspace", sessions: [] };
	const ws = {
		send: (json) => frames.push(JSON.parse(json)),
		deserializeAttachment: () => attachment,
		serializeAttachment: (value) => { attachment = value; },
	};
	const row = { sessionId: "s1", cwd: "/workspace", title: "Fixture", createdAt: 0, updatedAt: 0, entryCount: 0 };
	const actor = Object.create(UserAgentDO.prototype);
	const runner = {
		sessionId: "s1", running: false,
		validatePrompt() {},
		async prompt(text, behavior, images) { calls.push({ text, behavior, images }); },
	};
	Object.assign(actor, {
		env: { MAX_CONCURRENT_TURNS: "3" },
		ctx: { getWebSockets: () => [ws], acceptWebSocket() {} },
		store: { getSession: () => row, listSessions: () => [row], readEntries: () => [], lastSeq: () => 0 },
		rpc: { reject: (...args) => rpcErrors.push(args) },
		runners: new Map(),
		outbox: { flush() {}, pushAndFlush() {} },
		activeTurns: 0,
		runnerFor: async () => runner,
	});
	t.after(() => actor.clearKeepalive());
	const send = async (message) => {
		await actor.webSocketMessage(ws, JSON.stringify(message));
		await new Promise(setImmediate);
	};
	return { actor, ws, frames, calls, rpcErrors, runner, send };
}

test("one image prompt forwards all images in order and image-only/text-only messages both work", async (t) => {
	const { send, calls, frames } = harness(t);
	const second = { mimeType: "image/gif", data: Buffer.from("GIF89afixture").toString("base64") };
	await send({ t: "prompt", id: "p1", sessionId: "s1", text: "Compare", images: [image, second], streamingBehavior: "followUp" });
	assert.deepEqual(calls[0], { text: "Compare", behavior: "followUp", images: [image, second] });
	assert.deepEqual(frames[0], { t: "ack", id: "p1", ok: true });
	await send({ t: "prompt", id: "p2", sessionId: "s1", images: [image] });
	assert.equal(calls[1].text, "");
	await send({ t: "prompt", id: "p3", sessionId: "s1", text: "Hello" });
	assert.deepEqual(calls[2].images, []);
});

test("bad images and model capability errors are rejected before an acceptance ack", async (t) => {
	const { send, calls, frames, runner } = harness(t);
	await send({ t: "prompt", id: "bad", sessionId: "s1", images: [{ ...image, data: "data:image/png;base64," + image.data }] });
	assert.equal(frames[0].ok, false);
	assert.equal(calls.length, 0);
	runner.validatePrompt = () => { throw new Error("Model is text-only"); };
	await send({ t: "prompt", id: "unsupported", sessionId: "s1", images: [image] });
	assert.equal(frames.at(-1).ok, false);
	assert.match(frames.at(-1).error, /text-only/);
	assert.equal(calls.length, 0);
});

test("frame limits count UTF-8 bytes and preserve ordinary RPC failure handling", async (t) => {
	const { send, frames, calls, rpcErrors } = harness(t);
	await send({ t: "prompt", id: "unicode", sessionId: "s1", text: "\u4ef7".repeat(Math.ceil(MAX_CLIENT_MESSAGE_BYTES / 3)) });
	assert.equal(frames.at(-1).ok, false);
	assert.equal(calls.length, 0);
	await send({ t: "prompt", id: "oversize", sessionId: "s1", text: "x".repeat(IMAGE_PROMPT_LIMITS.maxPromptBytes), images: [image] });
	assert.equal(frames.at(-1).id, "oversize");
	assert.equal(frames.at(-1).ok, false);
	await send({ t: "op.result", callId: "op1", ok: true, result: "x".repeat(MAX_CLIENT_MESSAGE_BYTES) });
	assert.equal(rpcErrors[0][0], "op1");
	assert.match(rpcErrors[0][1], /exceeds/);
});

test("valid image prompts may exceed the old 1 MB frame cap without losing the attachment", async (t) => {
	const { send, frames, calls } = harness(t);
	const bytes = Buffer.alloc(IMAGE_PROMPT_LIMITS.maxImageBytes);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
	const large = { mimeType: "image/png", data: bytes.toString("base64") };
	const message = { t: "prompt", id: "large", sessionId: "s1", images: [large] };
	assert.ok(Buffer.byteLength(JSON.stringify(message)) > MAX_CLIENT_MESSAGE_BYTES);
	await send(message);
	assert.equal(frames[0].ok, true);
	assert.equal(calls[0].images[0].data.length, large.data.length);
});

test("ready advertises image support without changing the protocol version", async (t) => {
	const { actor, ws, frames } = harness(t);
	const oldPair = globalThis.WebSocketPair;
	const oldResponse = globalThis.Response;
	globalThis.WebSocketPair = class { constructor() { this[0] = {}; this[1] = ws; } };
	globalThis.Response = class { constructor(_body, init) { Object.assign(this, init); } };
	t.after(() => {
		if (oldPair === undefined) delete globalThis.WebSocketPair;
		else globalThis.WebSocketPair = oldPair;
		globalThis.Response = oldResponse;
	});
	const response = await actor.fetch({ url: "https://example.test/ws?uid=test" });
	assert.equal(response.status, 101);
	assert.equal(frames[0].protocolVersion, PROTOCOL_VERSION);
	assert.deepEqual(frames[0].capabilities.promptImages, IMAGE_PROMPT_LIMITS);
});

test("attach keeps images in history and acknowledges before sending the transcript", async (t) => {
	const { actor, ws, send, frames } = harness(t);
	actor.store.readEntries = () => [{ seq: 1, entryId: "u1", type: "message", entry: {
		type: "message", id: "u1", message: { role: "user", content: [{ type: "image", ...image }] },
	} }];
	actor.store.lastSeq = () => 1;
	await send({ t: "session.attach", id: "a1", sessionId: "s1" });
	assert.equal(frames[0].t, "ack");
	assert.equal(frames[1].t, "history");
	assert.equal(frames[1].messages[0].text, "");
	assert.equal(frames[1].messages[0].images[0].data, image.data);
	assert.equal(frames[1].lastSeq, 1);
	assert.equal(frames[1].hasMore, false);
	await actor.webSocketMessage(ws, new ArrayBuffer(1));
	assert.equal(frames.at(-1).t, "fatal");
	assert.match(frames.at(-1).message, /JSON text frame/);
});
