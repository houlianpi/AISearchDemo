import assert from "node:assert/strict";
import test from "node:test";
import { createHtmlProbeToolDefinition } from "../src/agent/html-probe.ts";
import { PAGE_EXTRACTION_BRIEF } from "../src/agent/task-prompt.ts";
import { createModelRuntime } from "../src/agent/model.ts";
import { createRemoteSession } from "../src/agent/session-factory.ts";

function context(window = 983040, tokens = 20000, maxTokens = 65536) {
	return {
		model: { contextWindow: window, maxTokens },
		getContextUsage: () => ({ contextWindow: window, tokens }),
	};
}

function toolFor(html) {
	return createHtmlProbeToolDefinition({ readFile: async () => html, resolvePath: (path) => path });
}

async function probe(html, params = {}, ctx = context()) {
	const result = await toolFor(html).execute("test", {
		path: "/workspace/source.html", mode: "full", ...params,
	}, undefined, undefined, ctx);
	return result.content[0].text;
}

test("full mode preserves a long single-line page, including SVG, without the 24K preview cap", async () => {
	const html = `<html><body><!-- region --><svg><path d="M0 0 L1 1"/></svg><script>keepAsData()</script><div>${"x".repeat(80000)}</div></body></html>`;
	const result = await probe(html);
	assert.match(result, /^COMPLETE HTML/);
	assert.ok(result.includes(html));
	assert.ok(result.length > 80000);
	assert.ok(result.endsWith("--- END CAPTURED HTML ---"));
	assert.match(result, /do not probe the same unchanged page again/);
});

test("oversized full reads return a regions summary, not the first chunk of the page", async () => {
	const html = `<svg><path d="${"M0 0 ".repeat(110000)}"/></svg><ul id="items">` +
		'<li class="entry">First record</li><li class="entry">Second record</li><li class="entry">Third record</li></ul>';
	const result = await probe(html);
	assert.match(result, /Full HTML not returned/);
	assert.match(result, /524288-byte budget/);
	assert.match(result, /records=3/);
	assert.match(result, /do not retry full\/regions or reconstruct the page with slices/);
	assert.doesNotMatch(result, /BEGIN CAPTURED HTML/);
	assert.ok(result.length < 24000);
});

test("full-read budgeting counts UTF-8 bytes and respects remaining context and output reserve", async () => {
	const html = `<div>${"\u4ef7".repeat(2100)}</div>`;
	const ctx = context(16000, 5000, 1000);
	const budget = 16000 - 5000 - 1000 - 4096;
	assert.ok(html.length < budget);
	assert.ok(Buffer.byteLength(html) > budget);
	const result = await probe(html, {}, ctx);
	assert.match(result, /Full HTML not returned/);
	assert.ok(Buffer.byteLength(result) <= budget);
	await assert.rejects(probe("<div>value</div>", {}, context(16000, 15000, 1000)), /Not enough remaining context/);
});

test("unknown context uses a conservative full-read budget and IO errors remain explicit", async () => {
	assert.match(await probe(`<div>${"x".repeat(50000)}</div>`, {}, { getContextUsage: () => undefined }), /49152-byte budget/);
	const tool = createHtmlProbeToolDefinition({
		resolvePath: (path) => path,
		readFile: async () => { throw new Error("file not found"); },
	});
	await assert.rejects(tool.execute("missing", { path: "missing.html", mode: "full" }), /file not found/);
});

test("existing structural modes remain available for oversized-page fallback", async () => {
	const html = '<ul id="items"><li class="entry">First record</li><li class="entry">Second record</li><li class="entry">Third record</li></ul>';
	assert.match(await probe(html, { mode: "regions" }), /records=3/);
	assert.match(await probe(html, { mode: "outline", selector: "li.entry" }), /First record/);
	assert.match(await probe(html, { mode: "search", query: "Second" }), /1 occurrences of "Second"/);
	assert.match(await probe(html, { mode: "slice", offset: 0, length: 10 }), /chars 0-10/);
});

test("capture metadata preserves locators without duplicating either HTML field", async () => {
	const source = JSON.stringify({
		url: "https://example.test/page", capturedAt: "2026-09-18T00:00:00Z", mode: "regions",
		regions: [{ id: "region-1", xpath: "/html/body/div[2]", selector: "#card", tag: "div", html: "PRIVATE_HTML".repeat(10000) }],
		sourceHtml: "DUPLICATED_HTML".repeat(10000),
	});
	const result = await probe(source, { path: "/workspace/source-regions.json", mode: "metadata" });
	const metadata = JSON.parse(result);
	assert.deepEqual(metadata.regions, [{ id: "region-1", xpath: "/html/body/div[2]", selector: "#card", tag: "div" }]);
	assert.equal(metadata.url, "https://example.test/page");
	assert.doesNotMatch(result, /PRIVATE_HTML|DUPLICATED_HTML/);
	assert.ok(result.length < 1000);
	for (const invalid of ["{", '{"rows":[]}', '{"regions":[null]}']) {
		await assert.rejects(probe(invalid, { mode: "metadata" }));
	}
	await assert.rejects(probe(JSON.stringify({ regions: [{ id: "r1", xpath: "x".repeat(25000) }] }), { mode: "metadata" }), /output limit/);
	assert.match(PAGE_EXTRACTION_BRIEF, /mode: "metadata"/);
	assert.match(PAGE_EXTRACTION_BRIEF, /Do not also emit an equivalent absolute CSS chain/);
});

test("registered full-read tool can recover the complete page after the native read limit", async (t) => {
	const html = `<html><body><div>${"x".repeat(80000)}</div></body></html>`;
	const bytes = Buffer.from(html);
	const env = {
		LLM_PROVIDER: "copilot", COPILOT_BASE_URL: "https://example.invalid/v1",
		COPILOT_API_KEY: "test-key", COPILOT_DEFAULT_MODEL: "gemini-3.8-flash",
	};
	const runtime = await createModelRuntime(env);
	const { session } = await createRemoteSession({
		env, modelRuntime: runtime, sessionId: "full-read-test",
		rpc: {
			async call({ op }) {
				if (op === "fs.access") return {};
				if (op === "fs.imageMimeType") return { mimeType: null };
				if (op === "fs.readFile") return { base64: bytes.toString("base64"), size: bytes.length };
				throw new Error(`Unexpected operation: ${op}`);
			},
		},
	});
	t.after(() => session.dispose());
	session.agent.state.messages = [{
		role: "assistant", content: [], api: session.model.api,
		provider: session.model.provider, model: session.model.id, timestamp: 0, stopReason: "toolUse",
		usage: {
			input: 20000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 20100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	}];
	const read = session.agent.state.tools.find((tool) => tool.name === "read");
	const full = session.agent.state.tools.find((tool) => tool.name === "html_probe");
	const limited = await read.execute("read", { path: "source.html" }, new AbortController().signal);
	assert.equal(limited.details.truncation.firstLineExceedsLimit, true);
	const complete = await full.execute("full", { path: "source.html", mode: "full" }, new AbortController().signal);
	assert.ok(complete.content[0].text.includes(html));
});

test("prompt and tool guidance prefer a complete read and forbid document-wide slicing", () => {
	const tool = toolFor("");
	assert.match(PAGE_EXTRACTION_BRIEF, /Read once, then build/);
	assert.match(PAGE_EXTRACTION_BRIEF, /with one\n`read \{ path \}` call/);
	assert.match(PAGE_EXTRACTION_BRIEF, /never crawl the document in 800\/1000-character steps/);
	assert.match(PAGE_EXTRACTION_BRIEF, /complete\n  page read is a stopping condition/);
	assert.doesNotMatch(PAGE_EXTRACTION_BRIEF, /Always start here|html_probe` is the only supported way/);
	assert.match(tool.description, /Prefer one read call/);
	assert.doesNotMatch(tool.description, /start here, always/);
});
