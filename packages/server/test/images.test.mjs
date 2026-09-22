import assert from "node:assert/strict";
import test from "node:test";
import { MAX_IMAGE_BYTES } from "../src/local/contracts.ts";
import { resolveImage } from "../src/local/images.ts";

const png = (size = 16) => {
	const bytes = Buffer.alloc(size);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	return bytes;
};

test("accepts a valid Base64 PNG", async () => {
	const data = png().toString("base64");
	assert.deepEqual(await resolveImage({ mimeType: "image/png", data }), { type: "image", mimeType: "image/png", data });
});

test("rejects malformed Base64 and MIME mismatch", async () => {
	await assert.rejects(() => resolveImage({ mimeType: "image/png", data: "not base64" }), { code: "INVALID_IMAGE_BASE64" });
	await assert.rejects(() => resolveImage({ mimeType: "image/jpeg", data: png().toString("base64") }), { code: "IMAGE_MIME_MISMATCH" });
});

test("enforces the 5 MiB decoded image limit", async () => {
	await assert.rejects(
		() => resolveImage({ mimeType: "image/png", data: png(MAX_IMAGE_BYTES + 1).toString("base64") }),
		{ status: 413, code: "IMAGE_TOO_LARGE" },
	);
});

test("accepts a supported image URL response", async () => {
	const bytes = png();
	const image = await resolveImage({ url: "https://example.test/photo.png" }, async () => new Response(bytes));
	assert.equal(image?.mimeType, "image/png");
});
