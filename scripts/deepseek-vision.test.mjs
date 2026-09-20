import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "./deepseek-vision.mjs";

async function setup(t, bytes = Buffer.from("RIFF0000WEBPfixture")) {
	const directory = await mkdtemp(join(tmpdir(), "deepseek-vision-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const image = join(directory, "image.webp");
	await writeFile(image, bytes);
	const overrides = {
		DEEPSEEK_API_KEY: "test-secret-key",
		DEEPSEEK_BASE_URL: "https://example.invalid/v1",
		DEEPSEEK_DEFAULT_MODEL: "deepseek-v4-flash",
	};
	const saved = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
	Object.assign(process.env, overrides);
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	const logs = [];
	t.mock.method(console, "log", (...values) => logs.push(values.join(" ")));
	return { image, bytes, logs };
}

test("sends the complete image with its correct MIME, current request settings and no answer hints", async (t) => {
	const { image, bytes, logs } = await setup(t);
	const response = { model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { content: "A landscape." } }] };
	const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
		assert.equal(url, "https://example.invalid/v1/chat/completions");
		assert.equal(options.headers.Authorization, "Bearer test-secret-key");
		assert.equal(options.redirect, "error");
		const body = JSON.parse(options.body);
		assert.equal(body.model, "deepseek-v4-flash");
		assert.deepEqual(body.thinking, { type: "enabled" });
		assert.equal(body.reasoning_effort, "medium");
		assert.equal(body.max_tokens, 2048);
		assert.equal(body.stream, false);
		assert.equal(body.messages.length, 1);
		assert.equal(body.messages[0].content[0].text, "What is in this image?");
		const dataUrl = body.messages[0].content[1].image_url.url;
		assert.ok(dataUrl.startsWith("data:image/webp;base64,"));
		assert.deepEqual(Buffer.from(dataUrl.split(",")[1], "base64"), bytes);
		return new Response(JSON.stringify(response), { status: 200 });
	});
	assert.deepEqual(await main([image, "What is in this image?"]), response);
	assert.equal(fetchMock.mock.callCount(), 1);
	assert.match(logs.join("\n"), /Raw DeepSeek response/);
	assert.match(logs.join("\n"), /A landscape/);
	assert.doesNotMatch(logs.join("\n"), /test-secret-key/);
});

test("HTTP errors remain visible without printing the credential even if echoed by the service", async (t) => {
	const { image, logs } = await setup(t);
	t.mock.method(globalThis, "fetch", async () => new Response(
		JSON.stringify({ error: { message: "Invalid token test-secret-key" } }), { status: 401 },
	));
	await assert.rejects(main([image]), /HTTP 401/);
	assert.match(logs.join("\n"), /\[REDACTED\]/);
	assert.doesNotMatch(logs.join("\n"), /test-secret-key/);
});

test("invalid image contents are rejected before any upload", async (t) => {
	const { image } = await setup(t, Buffer.from("not an image"));
	const fetchMock = t.mock.method(globalThis, "fetch", () => assert.fail("No upload expected"));
	await assert.rejects(main([image]), /Unsupported image contents/);
	assert.equal(fetchMock.mock.callCount(), 0);
});

test("a truncated or empty response is not reported as a completed recognition", async (t) => {
	const { image } = await setup(t);
	for (const choice of [
		{ finish_reason: "length", message: { content: "partial" } },
		{ finish_reason: "stop", message: { content: "" } },
	]) {
		t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [choice] }), { status: 200 }));
		await assert.rejects(main([image]), /max_tokens|no final text/);
	}
});
