import assert from "node:assert/strict";
import test from "node:test";
import { searchResultsFromEntries } from "../src/local/search-results.ts";

test("maps and deduplicates pi-web-access entries", () => {
	const entries = [{
		type: "custom", customType: "web-search-results",
		data: { type: "search", queries: [{ results: [
			{ title: "One", url: "https://example.com/one", snippet: "first" },
			{ title: "Again", url: "https://example.com/one", snippet: "duplicate" },
		] }] },
	}];
	assert.deepEqual(searchResultsFromEntries(entries, 0), [{
		title: "One", url: "https://example.com/one", snippet: "first", source: "example.com",
	}]);
});
