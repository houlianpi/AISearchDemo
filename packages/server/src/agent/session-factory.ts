import type { StoredEntry } from "@wa/protocol";
import { VIRTUAL_ROOT } from "@wa/protocol";
import { posix } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	buildSessionContext,
	createAgentSession,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DefaultResourceLoader,
	type ModelRuntime,
	type SessionContext,
	type SessionEntry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { OpRpc } from "../do/op-rpc.ts";
import type { Env } from "../env.ts";
import { createHtmlProbeToolDefinition } from "./html-probe.ts";
import { defaultThinkingLevel, resolveModel, resolveRestoredModel } from "./model.ts";
import { createRemoteOperations } from "./remote-ops.ts";
import { PAGE_EXTRACTION_BRIEF } from "./task-prompt.ts";

/**
 * Workers has no writable persistent filesystem (`/tmp` is per-request and
 * `node:fs` is an in-memory VFS), so every pi component is created in its
 * in-memory form and durability is provided by the Durable Object's SQLite.
 */

/** `grep` is intentionally absent: pi always shells out to ripgrep for it. */
export const REMOTE_TOOL_NAMES = ["read", "write", "edit", "bash", "ls", "find"] as const;

/** Server-side page analysis; not a pi built-in. */
const HTML_PROBE_TOOL_NAME = "html_probe";

export interface CreateRemoteSessionOptions {
	env: Env;
	modelRuntime: ModelRuntime;
	rpc: OpRpc;
	sessionId: string;
	/** Persisted entry log to replay. Model and thinking level are restored from it. */
	history?: StoredEntry[];
	/** Explicit model override. Wins over the persisted one. */
	modelId?: string;
}

export interface RemoteSession {
	session: AgentSession;
	/**
	 * The in-memory entry log. pi only emits `entry_appended` for extension
	 * entries, so durability is driven by draining this directly.
	 */
	sessionManager: SessionManager;
}

export async function createRemoteSession(options: CreateRemoteSessionOptions): Promise<RemoteSession> {
	const { env, modelRuntime, rpc, sessionId } = options;
	const cwd = VIRTUAL_ROOT;
	const agentDir = "/tmp/pi";

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 2 },
	});

	// Nothing is discovered from disk: no repo extensions, skills, prompts or
	// context files exist inside the Worker sandbox.
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		// The override seam takes literal text; the `systemPrompt` option would be
		// `existsSync`-probed as a file path first.
		systemPromptOverride: () => PAGE_EXTRACTION_BRIEF,
	});
	await resourceLoader.reload();

	const ops = createRemoteOperations(rpc, sessionId);
	// Same names as the built-ins: `customTools` are registered after built-ins
	// and therefore replace them in the tool registry.
	const customTools: ToolDefinition[] = [
		createReadToolDefinition(cwd, { operations: ops.read, autoResizeImages: false }),
		createWriteToolDefinition(cwd, { operations: ops.write }),
		createEditToolDefinition(cwd, { operations: ops.edit }),
		createBashToolDefinition(cwd, { operations: ops.bash }),
		createLsToolDefinition(cwd, { operations: ops.ls }),
		createFindToolDefinition(cwd, { operations: ops.find }),
		createHtmlProbeToolDefinition({
			readFile: async (path) => (await ops.read.readFile(path)).toString("utf-8"),
			resolvePath: (path) => posix.resolve(cwd, path.replace(/\\/g, "/")),
		}),
	] as ToolDefinition[];

	const sessionManager = SessionManager.inMemory(cwd, { id: sessionId });
	const restored = options.history ? restoreContext(options.history) : undefined;
	const model = options.modelId
		? resolveModel(modelRuntime, env, options.modelId)
		: resolveRestoredModel(modelRuntime, env, restored?.model);
	// A restored session keeps whatever level it was created with; only a new
	// session picks up the provider's default.
	const thinkingLevel = restored ? toThinkingLevel(restored.thinkingLevel) : defaultThinkingLevel(env);

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager,
		customTools,
		tools: [...REMOTE_TOOL_NAMES, HTML_PROBE_TOOL_NAME],
	});

	if (restored) {
		session.agent.state.messages = restored.messages;
	}

	return { session, sessionManager };
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function toThinkingLevel(value: string): ThinkingLevel | undefined {
	return THINKING_LEVELS.find((level) => level === value);
}

/**
 * Rebuilds a session context from persisted entries.
 *
 * Entries are stored in append order but each fresh `SessionManager` restarts
 * its own id/parent chain, so the tree is re-linked linearly before pi resolves
 * it. v1 has no branching or forking, which makes a linear re-link exact.
 */
function restoreContext(stored: StoredEntry[]): SessionContext | undefined {
	const entries: SessionEntry[] = [];
	const seen = new Set<string>();
	let previousId: string | null = null;

	for (const row of stored) {
		const entry = row.entry as SessionEntry | null;
		if (!entry || typeof entry !== "object" || !("id" in entry) || seen.has(entry.id)) continue;
		seen.add(entry.id);
		(entry as { parentId: string | null }).parentId = previousId;
		previousId = entry.id;
		entries.push(entry);
	}

	return entries.length > 0 ? buildSessionContext(entries, previousId) : undefined;
}
