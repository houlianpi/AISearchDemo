import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	PAGE_EXTRACTION_BRIEF, ROOT_RESOLUTION_EXAMPLE, stripEmbeddedBrief, withBrief,
} from "../src/agent/task-prompt.ts";
import { createModelRuntime, requiresUserBrief } from "../src/agent/model.ts";
import { SessionRunner } from "../src/do/session-runner.ts";

const resolveRoot = new Function(`return (${ROOT_RESOLUTION_EXAMPLE});`)();
const spec = { xpath: "/html[1]/body[1]/div[2]/main[1]/ol[1]/li[2]", selectors: ["#quote", ".quote-card", "li.answer"] };
const expected = { identity: "wanted", price: "123.45" };
const unrelated = { identity: "other" };
const validate = (node) => node.identity === "wanted" && node.price != null;

test("the copyable root resolver keeps a valid live-page XPath without broadening its scope", () => {
	const root = resolveRoot({
		evaluate: (xpath, doc, ns, type) => {
			assert.equal(xpath, spec.xpath);
			assert.equal(type, 9);
			return { singleNodeValue: expected };
		},
		querySelectorAll: () => assert.fail("A validated XPath needs no fallback"),
	}, spec, validate);
	assert.equal(root, expected);
	assert.ok(PAGE_EXTRACTION_BRIEF.includes(ROOT_RESOLUTION_EXAMPLE));
});

test("missing ancestors, body fragments and synthetic wrappers use ordered validated anchors", () => {
	for (const xpathResult of [null, unrelated]) {
		const queries = [];
		const root = resolveRoot({
			evaluate: () => ({ singleNodeValue: xpathResult }),
			querySelectorAll: (selector) => {
				queries.push(selector);
				assert.equal(selector.includes(","), false);
				if (selector === "#quote") return [expected];
				return [unrelated];
			},
		}, spec, validate);
		assert.equal(root, expected);
		assert.deepEqual(queries, ["#quote"]);
	}
	const root = resolveRoot({
		querySelectorAll: (selector) => selector === ".quote-card" ? [unrelated, expected] : [],
	}, spec, validate);
	assert.equal(root, expected);
});

test("root failures are explicit and unrelated evaluation errors are not swallowed", (t) => {
	const warnings = [];
	t.mock.method(console, "warn", (message) => warnings.push(message));
	assert.equal(resolveRoot({ evaluate: () => ({ singleNodeValue: unrelated }), querySelectorAll: () => [unrelated] }, spec, validate), null);
	assert.match(warnings[0], /failed field checks/);
	assert.equal(resolveRoot({
		evaluate: () => { throw Object.assign(new Error("unsupported"), { name: "NotSupportedError" }); },
		querySelectorAll: () => [expected],
	}, spec, validate), expected);
	assert.match(warnings[1], /XPath unavailable/);
	assert.throws(() => resolveRoot({
		evaluate: () => { throw new Error("unexpected runtime error"); },
		querySelectorAll: () => [expected],
	}, spec, validate), /unexpected runtime error/);
});

test("prompt differentiates source scope, true history, range-only data and unavailable fields", () => {
	for (const pattern of [
		/ORIGINAL live document/,
		/synthetic html\/body wrappers/,
		/Do not repair it by blindly deleting \/html\/body/,
		/NOT the first selector's match/,
		/52-week low\/high is a RANGE/,
		/If 1D is selected, do not relabel that series as 1Y/,
		/Never hardcode fallback prices/,
		/1-year history unavailable in this capture/,
		/Finishing in fewer calls does not justify\nguessing fields/,
		/remove empty\n  row grids/,
	]) assert.match(PAGE_EXTRACTION_BRIEF, pattern);
});

test("removing embedded briefs preserves images, user text, other roles and stored objects", () => {
	const image = { type: "image", mimeType: "image/png", data: "fixture" };
	const message = { role: "user", timestamp: 0, content: [{ type: "text", text: withBrief("Current request") }, image] };
	const before = structuredClone(message);
	const outgoing = stripEmbeddedBrief(message);
	assert.equal(outgoing.content[0].text, "Current request");
	assert.equal(outgoing.content[1], image);
	assert.deepEqual(message, before);
	const plain = { role: "user", content: "Keep my task", timestamp: 0 };
	const incomplete = { role: "user", content: "<agent_brief>not a complete generated prefix", timestamp: 0 };
	const quoted = { role: "user", content: "<agent_brief>quoted content</agent_brief>\nmy own task", timestamp: 0 };
	const assistant = { role: "assistant", content: [{ type: "text", text: withBrief("quoted material") }] };
	for (const unchanged of [plain, incomplete, quoted, assistant]) assert.equal(stripEmbeddedBrief(unchanged), unchanged);
	assert.equal(stripEmbeddedBrief({ ...plain, content: withBrief("Earlier request") }).content, "Earlier request");
});

const environments = {
	copilot: {
		LLM_PROVIDER: "copilot", COPILOT_BASE_URL: "https://example.invalid/v1",
		COPILOT_API_KEY: "test-key", COPILOT_DEFAULT_MODEL: "gemini-3.8-flash",
	},
	gateway: {
		LLM_PROVIDER: "gateway", LLM_BASE_URL: "https://example.invalid/v1",
		LLM_API_KEY: "test-key", DEFAULT_MODEL: "gpt-5.6-sol",
	},
	deepseek: {
		LLM_PROVIDER: "deepseek", DEEPSEEK_BASE_URL: "https://example.invalid/v1",
		DEEPSEEK_API_KEY: "test-key", DEEPSEEK_DEFAULT_MODEL: "deepseek-v4-flash",
	},
};

function textOf(message) {
	return typeof message.content === "string" ? message.content
		: message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

async function runnerFixture(t, provider, previous) {
	t.mock.method(console, "log", () => {});
	const env = environments[provider];
	const runtime = await createModelRuntime(env);
	const captures = [];
	t.mock.method(runtime, "streamSimple", (model, context) => {
		captures.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
		const stream = createAssistantMessageEventStream();
		const message = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: [{ type: "text", text: "Done" }], stopReason: "stop", timestamp: 0,
			usage: {
				input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	});
	const manager = SessionManager.inMemory("/workspace");
	manager.appendModelChange("copilot", "gemini-3.8-flash");
	manager.appendThinkingLevelChange("medium");
	if (previous !== undefined) manager.appendMessage({ role: "user", content: previous, timestamp: 0 });
	const history = previous === undefined ? [] : manager.getEntries().map((entry, seq) => ({
		seq, entryId: entry.id, type: entry.type, entry,
	}));
	const before = JSON.stringify(history);
	const events = [];
	const runner = await SessionRunner.open({
		env, modelRuntime: runtime, sessionId: "brief-test", cwd: "/workspace",
		rpc: { call: () => assert.fail("No IO is needed for prompt routing") },
		store: {
			readEntries: () => history,
			getSession: () => ({ title: "Fixture" }),
			appendEntry: () => {},
		},
		outbox: { push: (_session, event) => events.push(event), pushAndFlush: (_session, event) => events.push(event) },
	});
	t.after(() => runner.dispose());
	await runner.prompt("Current request");
	await runner.prompt("Follow-up");
	assert.ok(captures.length > 0, JSON.stringify({
		provider, restored: previous !== undefined,
		errors: events.filter((event) => event.k === "error" || event.errorMessage),
	}));
	assert.equal(JSON.stringify(history), before);
	return captures;
}

test("copilot sends one system brief on new and resumed sessions without modifying stored history", async (t) => {
	assert.equal(requiresUserBrief(environments.copilot), false);
	for (const previous of [undefined, withBrief("Earlier request")]) {
		const captures = await runnerFixture(t, "copilot", previous);
		for (const context of captures) {
			assert.ok(context.systemPrompt.includes(PAGE_EXTRACTION_BRIEF));
			const users = context.messages.filter((message) => message.role === "user").map(textOf);
			assert.equal(users.some((text) => text.includes("<agent_brief>")), false);
			assert.ok(users.includes("Current request"));
			if (previous !== undefined) assert.ok(users.includes("Earlier request"));
		}
	}
});

test("legacy providers retain one user fallback, including a provider switch from system-only history", async (t) => {
	for (const provider of ["gateway", "deepseek"]) {
		assert.equal(requiresUserBrief(environments[provider]), true);
		for (const previous of [undefined, "Earlier request", withBrief("Earlier request")]) {
			const captures = await runnerFixture(t, provider, previous);
			const users = captures.at(-1).messages.filter((message) => message.role === "user").map(textOf);
			assert.equal(users.filter((text) => text.startsWith("<agent_brief>")).length, 1);
			assert.equal(users.at(-1), "Follow-up");
		}
	}
});
