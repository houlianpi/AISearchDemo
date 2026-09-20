import assert from "node:assert/strict";
import test from "node:test";
import {
	clientMessageByteLimit, detectImageMimeType, IMAGE_PROMPT_LIMITS,
	imageByteLength, MAX_CLIENT_MESSAGE_BYTES, parsePromptInput, validatePromptImages,
} from "../src/index.ts";

const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function png(length = 16) {
	const bytes = Buffer.alloc(length);
	header.copy(bytes);
	return { mimeType: "image/png", data: bytes.toString("base64") };
}

test("text-only prompts remain valid and image-only prompts normalize missing text", () => {
	assert.deepEqual(parsePromptInput({ text: "Hello" }), { text: "Hello", images: [], streamingBehavior: undefined });
	const image = png();
	assert.deepEqual(parsePromptInput({ images: [image], streamingBehavior: "followUp" }), {
		text: "", images: [image], streamingBehavior: "followUp",
	});
	assert.equal(clientMessageByteLimit({ t: "prompt" }), MAX_CLIENT_MESSAGE_BYTES);
	assert.equal(clientMessageByteLimit({ t: "prompt", images: [image] }), IMAGE_PROMPT_LIMITS.maxPromptBytes);
	assert.equal(clientMessageByteLimit({ t: "op.result", images: [image] }), MAX_CLIENT_MESSAGE_BYTES);
});

test("bad images, misleading MIME and malformed prompt fields fail explicitly", () => {
	const image = png();
	for (const images of [
		null, "image", [null], [{ data: image.data }], [{ mimeType: "image/svg+xml", data: image.data }],
		[{ ...image, mimeType: "image/jpeg" }], [{ ...image, data: "" }],
		[{ ...image, data: "data:image/png;base64," + image.data }],
		[{ ...image, data: image.data + "\n" }], [{ ...image, data: "AAAA_" }],
		[{ ...image, data: image.data.slice(0, -3) + "B==" }],
	]) assert.throws(() => validatePromptImages(images));
	for (const input of [{}, { text: "" }, { text: null, images: [image] }, { text: "hi", streamingBehavior: "bad" }]) {
		assert.throws(() => parsePromptInput(input));
	}
});

test("per-image, aggregate and count limits include exact byte boundaries", () => {
	const maximum = png(IMAGE_PROMPT_LIMITS.maxImageBytes);
	assert.equal(imageByteLength(validatePromptImages([maximum])[0].data), IMAGE_PROMPT_LIMITS.maxImageBytes);
	assert.throws(() => validatePromptImages([png(IMAGE_PROMPT_LIMITS.maxImageBytes + 1)]), /limit/);
	const half = png(IMAGE_PROMPT_LIMITS.maxTotalImageBytes / 2);
	assert.equal(validatePromptImages([half, half]).length, 2);
	assert.throws(() => validatePromptImages([half, png(IMAGE_PROMPT_LIMITS.maxTotalImageBytes / 2 + 1)]), /Combined/);
	assert.equal(validatePromptImages(Array(4).fill(png())).length, 4);
	assert.throws(() => validatePromptImages(Array(5).fill(png())), /At most 4/);
});

test("MIME detection is based on signatures, not filenames", () => {
	assert.equal(detectImageMimeType(header), "image/png");
	assert.equal(detectImageMimeType(Buffer.from([255, 216, 255])), "image/jpeg");
	assert.equal(detectImageMimeType(Buffer.from("RIFF0000WEBP")), "image/webp");
	assert.equal(detectImageMimeType(Buffer.from("GIF89a")), "image/gif");
	assert.equal(detectImageMimeType(Buffer.from("<svg/>")), undefined);
	assert.equal(detectImageMimeType(new Uint8Array()), undefined);
});
