import assert from "node:assert/strict";
import test from "node:test";
import { interleaveBySource, searchResultsFromEntries } from "../src/local/search-results.ts";

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

test("interleaves sources, keeps source rank, and caps each source at two", () => {
	const result = (source, rank) => ({
		title: `${source}-${rank}`, url: `https://${source}/${rank}`, snippet: "", source,
	});
	const input = [
		result("shop-a.test", 1), result("shop-a.test", 2), result("shop-a.test", 3),
		result("shop-b.test", 1), result("shop-b.test", 2), result("shop-b.test", 3),
		result("shop-c.test", 1),
	];

	assert.deepEqual(interleaveBySource(input).map((item) => item.title), [
		"shop-a.test-1", "shop-b.test-1", "shop-c.test-1",
		"shop-a.test-2", "shop-b.test-2",
	]);
});

test("returns no more than ten diverse results", () => {
	const input = Array.from({ length: 12 }, (_, index) => ({
		title: `Result ${index}`, url: `https://shop-${index}.test/item`, snippet: "", source: `shop-${index}.test`,
	}));
	assert.equal(interleaveBySource(input).length, 10);
});
