import { Buffer } from "node:buffer";
import type {
	BashOperations,
	EditOperations,
	FindOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASH_TIMEOUT_MS, type OpRpc } from "../do/op-rpc.ts";

/**
 * pi's tools, wired to a remote executor.
 *
 * pi deliberately exposes an `*Operations` seam on every built-in tool
 * ("Override these to delegate ... to remote systems"). Implementing that seam
 * keeps pi's argument validation, truncation, diffing and prompt text intact
 * while the actual IO happens on the user's machine.
 */
export function createRemoteOperations(rpc: OpRpc, sessionId: string) {
	const bash: BashOperations = {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = timeout !== undefined ? timeout * 1000 : undefined;
			return rpc.call({
				op: "bash.exec",
				args: { command, cwd, timeoutMs, env: sessionEnv(env) },
				sessionId,
				signal,
				onUpdate: (chunk) => onData(Buffer.from(chunk)),
				// Give the client a little slack past its own timeout before we give up.
				timeoutMs: (timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS) + 5_000,
			});
		},
	};

	const readFile = async (path: string): Promise<Buffer> => {
		const { base64 } = await rpc.call({ op: "fs.readFile", args: { path }, sessionId });
		return Buffer.from(base64, "base64");
	};

	const read: ReadOperations = {
		readFile,
		access: async (path) => {
			await rpc.call({ op: "fs.access", args: { path, mode: "r" }, sessionId });
		},
		detectImageMimeType: async (path) => {
			const { mimeType } = await rpc.call({ op: "fs.imageMimeType", args: { path }, sessionId });
			return mimeType;
		},
	};

	const edit: EditOperations = {
		readFile,
		writeFile: async (path, content) => {
			await rpc.call({ op: "fs.writeFile", args: { path, content }, sessionId });
		},
		access: async (path) => {
			await rpc.call({ op: "fs.access", args: { path, mode: "rw" }, sessionId });
		},
	};

	const write: WriteOperations = {
		writeFile: async (path, content) => {
			await rpc.call({ op: "fs.writeFile", args: { path, content }, sessionId });
		},
		mkdir: async (path) => {
			await rpc.call({ op: "fs.mkdir", args: { path }, sessionId });
		},
	};

	const ls: LsOperations = {
		exists: async (path) => (await rpc.call({ op: "fs.exists", args: { path }, sessionId })).exists,
		stat: async (path) => {
			const stat = await rpc.call({ op: "fs.stat", args: { path }, sessionId });
			return { isDirectory: () => stat.isDirectory };
		},
		readdir: async (path) => (await rpc.call({ op: "fs.readdir", args: { path }, sessionId })).entries,
	};

	const find: FindOperations = {
		exists: async (path) => (await rpc.call({ op: "fs.exists", args: { path }, sessionId })).exists,
		glob: async (pattern, cwd, options) => {
			const { paths } = await rpc.call({
				op: "fs.glob",
				args: { pattern, cwd, ignore: options.ignore, limit: options.limit },
				sessionId,
			});
			return paths;
		},
	};

	return { bash, read, edit, write, ls, find };
}

/**
 * Narrows pi's child-process environment to its own `PI_*` session variables.
 *
 * pi derives that environment from the server's `process.env`, which Workers
 * populates from bindings — including `LLM_API_KEY`. Forwarding it wholesale
 * would inject the gateway key into every shell on the user's machine.
 */
function sessionEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const forwarded: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith("PI_") && value !== undefined) forwarded[key] = value;
	}
	return Object.keys(forwarded).length > 0 ? forwarded : undefined;
}
