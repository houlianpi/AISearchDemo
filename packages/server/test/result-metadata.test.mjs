import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicHttpUrl, enrichTopSearchResults, parsePageMetadata } from "../src/local/result-metadata.ts";

const HTML = `<!doctype html><html><head>
<meta property="og:title" content="EVO SL review">
<meta property="og:description" content="A fast daily trainer.">
<meta property="og:site_name" content="Run Lab">
<meta property="og:image" content="/images/shoe.jpg">
<meta property="article:published_time" content="2026-02-04">
<meta name="author" content="Alex Runner">
<link rel="icon" href="../favicon.png">
</head></html>`;

test("parses Open Graph, article metadata, and relative assets", () => {
	assert.deepEqual(parsePageMetadata(HTML, new URL("https://run.example/reviews/evo")), {
		title: "EVO SL review", snippet: "A fast daily trainer.", sourceName: "Run Lab",
		faviconUrl: "https://run.example/favicon.png", thumbnailUrl: "https://run.example/images/shoe.jpg",
		publishedAt: "2026-02-04", author: "Alex Runner", contentType: "page",
	});
});

test("parses JSON-LD VideoObject metadata and duration", () => {
	const html = `<script type="application/ld+json">${JSON.stringify({
		"@context": "https://schema.org", "@type": "VideoObject", name: "Review",
		datePublished: "2026-01-02", duration: "PT8M41S", thumbnailUrl: ["/video.jpg"], author: { name: "The Run Testers" },
	})}</script>`;
	assert.deepEqual(parsePageMetadata(html, new URL("https://video.example/watch/1")), {
		thumbnailUrl: "https://video.example/video.jpg", publishedAt: "2026-01-02",
		author: "The Run Testers", contentType: "video", duration: "8:41",
	});
});

test("enriches only the first three results and preserves original click URLs", async () => {
	const called = [];
	const results = Array.from({ length: 5 }, (_, index) => ({
		title: `Original ${index}`, url: `https://site-${index}.example/item`, snippet: "original", source: `site-${index}.example`,
	}));
	const enriched = await enrichTopSearchResults(results, {
		resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
		fetcher: async (url) => { called.push(String(url)); return new Response(HTML, { headers: { "content-type": "text/html" } }); },
	});
	assert.equal(called.length, 3);
	assert.equal(enriched[0].url, results[0].url);
	assert.equal(enriched[0].title, "EVO SL review");
	assert.deepEqual(enriched.slice(3), results.slice(3));
});

test("fetch failure and timeout preserve original results", async () => {
	const results = [{ title: "Original", url: "https://public.example/item", snippet: "keep", source: "public.example" }];
	const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];
	assert.deepEqual(await enrichTopSearchResults(results, { resolveHost, fetcher: async () => { throw new Error("offline"); } }), results);
	assert.deepEqual(await enrichTopSearchResults(results, {
		resolveHost, timeoutMs: 5, fetcher: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
	}), results);
});

test("rejects local, private, link-local, and internal destinations", async () => {
	await assert.rejects(() => assertPublicHttpUrl(new URL("http://localhost/page")));
	await assert.rejects(() => assertPublicHttpUrl(new URL("http://127.0.0.1/page")));
	await assert.rejects(() => assertPublicHttpUrl(new URL("http://service.internal/page")));
	await assert.rejects(() => assertPublicHttpUrl(new URL("https://public.example/page"), async () => [{ address: "192.168.1.3", family: 4 }]));
	await assert.rejects(() => assertPublicHttpUrl(new URL("https://public.example/page"), async () => [{ address: "169.254.1.3", family: 4 }]));
});

test("revalidates redirect destinations before following", async () => {
	const results = [{ title: "Original", url: "https://public.example/item", snippet: "keep", source: "public.example" }];
	let calls = 0;
	const enriched = await enrichTopSearchResults(results, {
		resolveHost: async (host) => [{ address: host === "private.example" ? "10.0.0.3" : "93.184.216.34", family: 4 }],
		fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://private.example/secret" } }); },
	});
	assert.equal(calls, 1);
	assert.deepEqual(enriched, results);
});

test("drops metadata images that resolve to a private address", async () => {
	const results = [{ title: "Original", url: "https://public.example/item", snippet: "keep", source: "public.example" }];
	const html = '<meta property="og:image" content="http://assets.internal/secret.png"><meta property="og:title" content="Safe title">';
	const enriched = await enrichTopSearchResults(results, {
		resolveHost: async (host) => [{ address: host === "assets.internal" ? "10.0.0.4" : "93.184.216.34", family: 4 }],
		fetcher: async () => new Response(html, { headers: { "content-type": "text/html" } }),
	});
	assert.equal(enriched[0].title, "Safe title");
	assert.equal(enriched[0].thumbnailUrl, undefined);
});
