import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IMAGE_PROMPT_LIMITS } from "@wa/protocol";
import { prepareImagePrompt, prepareImagesPrompt } from "../src/image-prompt.ts";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "wa-image-prompt-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const bytes = Buffer.from("RIFF0000WEBPfixture");
	await writeFile(join(directory, "photo with spaces.webp"), bytes);
	return { directory, bytes };
}

test("quoted local paths support captions and image-only messages without exposing the path to the model", async (t) => {
	const { directory, bytes } = await fixture(t);
	const prompt = await prepareImagePrompt('"photo with spaces.webp" What is here?', directory);
	assert.equal(prompt.text, "What is here?");
	assert.equal(prompt.images[0].mimeType, "image/webp");
	assert.equal(prompt.images[0].data, bytes.toString("base64"));
	assert.equal("path" in prompt.images[0], false);
	assert.equal((await prepareImagePrompt("'photo with spaces.webp'", directory)).text, "");
});

test("multiple image paths form one ordered prompt with an optional caption", async (t) => {
	const { directory, bytes } = await fixture(t);
	const second = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8)]);
	await writeFile(join(directory, "second.png"), second);
	const prompt = await prepareImagesPrompt('"photo with spaces.webp" second.png -- Compare these two images', directory);
	assert.equal(prompt.text, "Compare these two images");
	assert.equal(prompt.images.length, 2);
	assert.equal(prompt.images[0].data, bytes.toString("base64"));
	assert.equal(prompt.images[1].data, second.toString("base64"));
	assert.equal((await prepareImagesPrompt('second.png "photo with spaces.webp"', directory)).text, "");
	await assert.rejects(prepareImagesPrompt("-- question", directory), /Usage/);
	await assert.rejects(prepareImagesPrompt('"unclosed', directory), /Usage/);
	await assert.rejects(prepareImagesPrompt(Array(5).fill("second.png").join(" "), directory), /At most 4/);
	await assert.rejects(prepareImagesPrompt('second.png "photo with spaces.webp"', directory, {
		...IMAGE_PROMPT_LIMITS, maxTotalImageBytes: second.length + bytes.length - 1,
	}), /Combined/);
});

test("invalid paths, image contents and server limits are explicit errors", async (t) => {
	const { directory } = await fixture(t);
	await writeFile(join(directory, "not-image.webp"), "plain text");
	await mkdir(join(directory, "folder"));
	await writeFile(join(directory, "large.webp"), Buffer.alloc(IMAGE_PROMPT_LIMITS.maxImageBytes + 1));
	for (const command of ["", '"unclosed', "missing.webp", "not-image.webp", "folder", "large.webp"]) {
		await assert.rejects(prepareImagePrompt(command, directory));
	}
	await assert.rejects(prepareImagePrompt('"photo with spaces.webp"', directory, {
		...IMAGE_PROMPT_LIMITS, mimeTypes: ["image/png"],
	}), /Unsupported image/);
	await assert.rejects(prepareImagePrompt('"photo with spaces.webp"', directory, {
		...IMAGE_PROMPT_LIMITS, maxImageBytes: 1,
	}), /exceeds/);
});
