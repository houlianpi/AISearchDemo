import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SearchResult } from "./contracts.ts";

interface PluginSearchResult { title?: unknown; url?: unknown; snippet?: unknown; thumbnailUrl?: unknown }

const MAX_RESULTS = 10;
const MAX_RESULTS_PER_SOURCE = 2;

export function searchResultsFromEntries(entries: readonly SessionEntry[], fromIndex: number): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const entry of entries.slice(fromIndex)) {
		if (entry.type !== "custom" || entry.customType !== "web-search-results") continue;
		const data = entry.data as { type?: unknown; queries?: unknown } | undefined;
		if (data?.type !== "search" || !Array.isArray(data.queries)) continue;
		for (const query of data.queries) {
			if (!query || typeof query !== "object") continue;
			const items = (query as { results?: unknown }).results;
			if (!Array.isArray(items)) continue;
			for (const raw of items) {
				const item = raw as PluginSearchResult;
				if (typeof item.url !== "string" || typeof item.title !== "string" || seen.has(item.url)) continue;
				seen.add(item.url);
				let source = item.url;
				try { source = new URL(item.url).hostname; } catch {}
				results.push({
					title: item.title,
					url: item.url,
					snippet: typeof item.snippet === "string" ? item.snippet : "",
					...(typeof item.thumbnailUrl === "string" ? { thumbnailUrl: item.thumbnailUrl } : {}),
					source,
				});
			}
		}
	}
	return interleaveBySource(results);
}

/**
 * Keeps each site's original relevance order while round-robin interleaving
 * sites, so one marketplace cannot dominate the response.
 */
export function interleaveBySource(results: readonly SearchResult[]): SearchResult[] {
	const groups = new Map<string, SearchResult[]>();
	for (const result of results) {
		const group = groups.get(result.source);
		if (group) {
			if (group.length < MAX_RESULTS_PER_SOURCE) group.push(result);
		} else {
			groups.set(result.source, [result]);
		}
	}

	const ordered: SearchResult[] = [];
	for (let rank = 0; rank < MAX_RESULTS_PER_SOURCE && ordered.length < MAX_RESULTS; rank++) {
		for (const group of groups.values()) {
			const result = group[rank];
			if (result) ordered.push(result);
			if (ordered.length === MAX_RESULTS) break;
		}
	}
	return ordered;
}

export function demoFallbackResults(): SearchResult[] {
	return [{
		title: "Demo fallback: search provider unavailable",
		url: "https://example.invalid/demo-search-fallback",
		snippet: "Synthetic result used only to keep a recorded demonstration deterministic.",
		source: "demo-fallback",
	}];
}
