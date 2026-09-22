import assert from "node:assert/strict";
import test from "node:test";
import { buildMessageRequest, MAX_IMAGE_BYTES, RequestLifecycle, validateImageFile } from "../public/client-logic.js";

test("client accepts JPEG, PNG, and WebP up to 5 MiB", () => {
	for (const type of ["image/jpeg", "image/png", "image/webp"]) {
		assert.doesNotThrow(() => validateImageFile({ type, size: MAX_IMAGE_BYTES }));
	}
});

test("new session aborts and invalidates an in-flight request", () => {
	const requests = new RequestLifecycle();
	const oldRequest = requests.start();
	assert.equal(requests.isCurrent(oldRequest), true);
	requests.cancel();
	assert.equal(oldRequest.controller.signal.aborted, true);
	assert.equal(requests.isCurrent(oldRequest), false);
	const newRequest = requests.start();
	assert.equal(requests.isCurrent(newRequest), true);
	assert.equal(requests.isCurrent(oldRequest), false);
});

test("client rejects unsupported and oversized images", () => {
	assert.throws(() => validateImageFile({ type: "image/gif", size: 10 }), /JPEG, PNG, or WebP/);
	assert.throws(() => validateImageFile({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }), /5 MiB/);
});

test("follow-up requests omit the image while preserving the prompt", () => {
	const image = { mimeType: "image/png", data: "abc" };
	assert.deepEqual(buildMessageRequest("Identify this", image), { prompt: "Identify this", image });
	assert.deepEqual(buildMessageRequest("What brand was it?", null), { prompt: "What brand was it?" });
});
