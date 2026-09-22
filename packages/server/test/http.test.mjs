import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HttpError } from "../src/local/contracts.ts";
import { createHttpHandler } from "../src/local/http.ts";

async function withServer(service, run) {
	const server = createServer(createHttpHandler(service));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

test("POST message returns the service JSON", async () => {
	let received;
	await withServer({ message: async (sessionId, body) => {
		received = { sessionId, body };
		return { sessionId, answer: "ok", imageAnalysis: null, searchResults: [], searchMode: "not-used" };
	} }, async (base) => {
		const response = await fetch(`${base}/v1/sessions/demo-1/messages`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello" }),
		});
		assert.equal(response.status, 200);
		assert.equal((await response.json()).answer, "ok");
	});
	assert.deepEqual(received, { sessionId: "demo-1", body: { prompt: "hello" } });
});

test("rejects every route and method except the one API", async () => {
	await withServer({ message: async () => assert.fail() }, async (base) => {
		assert.equal((await fetch(`${base}/health`)).status, 404);
		assert.equal((await fetch(`${base}/v1/sessions/demo/messages`)).status, 404);
	});
});

test("returns structured errors for invalid JSON and media types", async () => {
	await withServer({ message: async () => assert.fail() }, async (base) => {
		const media = await fetch(`${base}/v1/sessions/demo/messages`, { method: "POST", body: "{}" });
		assert.equal(media.status, 415);
		assert.equal((await media.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");

		const json = await fetch(`${base}/v1/sessions/demo/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
		assert.equal(json.status, 400);
		assert.equal((await json.json()).error.code, "INVALID_JSON");
	});
});

test("maps an oversized image failure to HTTP 413 JSON", async () => {
	const tooLarge = new HttpError(413, "IMAGE_TOO_LARGE", "Image must not exceed 5 MiB.");
	await withServer({ message: async () => { throw tooLarge; } }, async (base) => {
		const response = await fetch(`${base}/v1/sessions/demo/messages`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "inspect" }),
		});
		assert.equal(response.status, 413);
		assert.equal((await response.json()).error.code, "IMAGE_TOO_LARGE");
	});
});
