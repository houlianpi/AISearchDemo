import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocketServer } from "ws";
import { IMAGE_PROMPT_LIMITS, PROTOCOL_VERSION } from "@wa/protocol";

async function fixture(t, supportsImages) {
	const directory = await mkdtemp(join(tmpdir(), "wa-cli-images-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
	const webp = Buffer.from("RIFF0000WEBPfixture");
	await writeFile(join(directory, "one image.png"), png);
	await writeFile(join(directory, "two.webp"), webp);
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await once(server, "listening");
	let client;
	const prompts = [];
	const promptWaiters = [];
	server.on("connection", (socket) => {
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			if (message.t === "session.create") {
				socket.send(JSON.stringify({ t: "ack", id: message.id, ok: true, data: { session: { sessionId: "s1" } } }));
			} else if (message.t === "prompt") {
				prompts.push(message);
				socket.send(JSON.stringify({ t: "ack", id: message.id, ok: true }));
				socket.send(JSON.stringify({ t: "stream", sessionId: "s1", events: [{ k: "agent_end" }] }));
				promptWaiters.shift()?.(message);
			}
		});
		socket.send(JSON.stringify({
			t: "ready", protocolVersion: PROTOCOL_VERSION, userId: "test", sessions: [], maxConcurrentTurns: 3,
			...(supportsImages ? { capabilities: { promptImages: IMAGE_PROMPT_LIMITS } } : {}),
		}));
	});
	t.after(async () => {
		const exited = client && client.exitCode === null && client.signalCode === null ? once(client, "exit") : undefined;
		if (exited) client.kill();
		for (const socket of server.clients) socket.terminate();
		await new Promise((resolve) => server.close(resolve));
		if (exited) await exited;
	});
	client = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../src/index.ts", import.meta.url))], {
		env: {
			...process.env, WA_SERVER_URL: `ws://127.0.0.1:${server.address().port}`,
			WA_USER_ID: "image-test", WA_CWD: directory,
		},
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let output = "";
	const outputWaiters = [];
	const collect = (chunk) => {
		output += chunk.toString();
		for (const waiter of [...outputWaiters]) {
			if (output.includes(waiter.text)) {
				outputWaiters.splice(outputWaiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
	};
	client.stdout.on("data", collect);
	client.stderr.on("data", collect);
	client.on("exit", () => {
		for (const waiter of outputWaiters.splice(0)) waiter.reject(new Error(`CLI exited before ${waiter.text}: ${output}`));
	});
	const waitForOutput = (text) => output.includes(text) ? Promise.resolve()
		: new Promise((resolve, reject) => outputWaiters.push({ text, resolve, reject }));
	await waitForOutput("\n> ");
	return {
		client, prompts, png, webp, waitForOutput,
		nextPrompt: () => new Promise((resolve) => promptWaiters.push(resolve)),
		async quit() {
			const exited = once(client, "exit");
			client.stdin.write("/quit\n");
			const [code] = await exited;
			assert.equal(code, 0);
		},
	};
}

test("the CLI sends multiple files in one prompt over a real local WebSocket", { timeout: 15000 }, async (t) => {
	const f = await fixture(t, true);
	const received = f.nextPrompt();
	f.client.stdin.write('/images "one image.png" two.webp -- Compare these pictures\n');
	const message = await received;
	assert.equal(f.prompts.length, 1);
	assert.equal(message.text, "Compare these pictures");
	assert.equal(message.images.length, 2);
	assert.equal(message.images[0].mimeType, "image/png");
	assert.equal(message.images[0].data, f.png.toString("base64"));
	assert.equal(message.images[1].data, f.webp.toString("base64"));
	await f.quit();
});

test("old servers still accept text, while image commands fail locally rather than being silently ignored", { timeout: 15000 }, async (t) => {
	const f = await fixture(t, false);
	f.client.stdin.write('/image "one image.png"\n');
	await f.waitForOutput("does not advertise image prompts");
	assert.equal(f.prompts.length, 0);
	const received = f.nextPrompt();
	f.client.stdin.write("Hello\n");
	const message = await received;
	assert.equal(message.text, "Hello");
	assert.equal(message.images, undefined);
	await f.quit();
});
