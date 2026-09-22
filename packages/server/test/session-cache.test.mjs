import assert from "node:assert/strict";
import test from "node:test";
import { SessionCache } from "../src/local/session-cache.ts";

test("keeps sessions for ten minutes and expires them lazily", () => {
	let now = 0;
	let disposed = 0;
	const cache = new SessionCache(10 * 60 * 1000, () => now);
	const session = { dispose: () => { disposed++; } };
	cache.set("demo", session);
	now = 9 * 60 * 1000;
	assert.equal(cache.get("demo"), session);
	now = 19 * 60 * 1000 - 1;
	assert.equal(cache.get("demo"), session);
	now = 29 * 60 * 1000;
	assert.equal(cache.get("demo"), undefined);
	assert.equal(disposed, 1);
});
