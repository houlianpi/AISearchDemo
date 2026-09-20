import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_PROMPT_LIMITS } from "@wa/protocol";
import { MAX_HISTORY_FRAME_BYTES, toHistoryFrames, toHistoryMessages } from "../src/do/history.ts";
import { withBrief } from "../src/agent/task-prompt.ts";

function image(length = 16) {
	const bytes = Buffer.alloc(length);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
	return { type: "image", mimeType: "image/png", data: bytes.toString("base64") };
}

function row(seq, content) {
	return { seq, entryId: `e${seq}`, type: "message", entry: {
		id: `e${seq}`, type: "message", parentId: null, message: { role: "user", content, timestamp: 0 },
	} };
}

test("history preserves image-only turns and strips the brief without stripping images", () => {
	const picture = image();
	const history = toHistoryMessages([
		row(1, [{ type: "text", text: withBrief("Describe it") }, picture]),
		row(2, [picture]),
		row(3, "Plain text"),
	]);
	assert.equal(history[0].text, "Describe it");
	assert.equal(history[0].images[0].data, picture.data);
	assert.equal(history[1].text, "");
	assert.equal(history[1].images.length, 1);
	assert.deepEqual(history[2], { k: "user", text: "Plain text" });
});

test("large image transcripts replay in bounded frames with resumable sequence cursors", () => {
	const picture = image(IMAGE_PROMPT_LIMITS.maxImageBytes);
	const entries = Array.from({ length: 5 }, (_, index) => row(index + 1, [picture]));
	const frames = toHistoryFrames("s1", entries, 5);
	assert.equal(frames.length, 2);
	assert.equal(frames[0].hasMore, true);
	assert.equal(frames[0].lastSeq, 3);
	assert.equal(frames[1].hasMore, false);
	assert.equal(frames[1].lastSeq, 5);
	assert.equal(frames.flatMap((frame) => frame.messages).length, 5);
	for (const frame of frames) {
		assert.ok(Buffer.byteLength(JSON.stringify(frame), "utf8") <= MAX_HISTORY_FRAME_BYTES);
		for (const message of frame.messages) assert.equal(message.images[0].data.length, picture.data.length);
	}
	assert.deepEqual(toHistoryFrames("s1", [], 5), [{ t: "history", sessionId: "s1", messages: [], lastSeq: 5, hasMore: false }]);
	assert.throws(() => toHistoryFrames("s1", [row(1, "x".repeat(MAX_HISTORY_FRAME_BYTES))], 1), /replay frame limit/);
});
