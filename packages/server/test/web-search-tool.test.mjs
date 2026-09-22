import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWebSearchArguments } from "../src/local/web-search-tool.ts";

test("empty queries no longer mask a valid singular search query", () => {
	assert.deepEqual(normalizeWebSearchArguments({
		query: "Nike Alphafly 3", queries: [], provider: "tavily", workflow: "none", numResults: 5,
	}), { query: "Nike Alphafly 3", provider: "tavily", workflow: "none", numResults: 5 });
});

test("non-empty batch queries and other malformed values remain untouched", () => {
	assert.deepEqual(normalizeWebSearchArguments({ query: "one", queries: ["two"] }), { query: "one", queries: ["two"] });
	assert.equal(normalizeWebSearchArguments(null), null);
});
