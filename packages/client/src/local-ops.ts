import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import type { RemoteOpArgs, RemoteOpName, RemoteOpResult } from "@wa/protocol";
import { VIRTUAL_ROOT } from "@wa/protocol";

/**
 * Local execution of the operations the remote agent asks for.
 *
 * v1 runs everything unattended (no approval prompt), which means anything the
 * model is talked into requesting runs with this process's privileges. Only
 * point the client at a server and a working directory you trust.
 */

export interface OpContext {
	cwd: string;
	signal: AbortSignal;
	/** Streams partial stdout/stderr back to the server while a command runs. */
	onUpdate: (chunk: Buffer) => void;
}

type Handler<K extends RemoteOpName> = (args: RemoteOpArgs<K>, ctx: OpContext) => Promise<RemoteOpResult<K>>;

const IMAGE_EXTENSIONS: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const handlers: { [K in RemoteOpName]: Handler<K> } = {
	"bash.exec": async ({ command, cwd, timeoutMs, env }, ctx) => {
		const workdir = absolute(cwd, ctx.cwd);
		return new Promise((resolveExec, rejectExec) => {
			const isWindows = process.platform === "win32";
			const child = spawn(isWindows ? "powershell.exe" : "/bin/bash", isWindows ? ["-NoProfile", "-Command", command] : ["-lc", command], {
				cwd: workdir,
				env: env ? { ...process.env, ...env } : process.env,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let timer: NodeJS.Timeout | undefined;
			const kill = () => {
				child.kill("SIGKILL");
			};
			if (timeoutMs !== undefined) timer = setTimeout(kill, timeoutMs);
			ctx.signal.addEventListener("abort", kill, { once: true });

			child.stdout.on("data", (chunk: Buffer) => ctx.onUpdate(chunk));
			child.stderr.on("data", (chunk: Buffer) => ctx.onUpdate(chunk));
			child.on("error", (error) => {
				if (timer) clearTimeout(timer);
				rejectExec(error);
			});
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				resolveExec({ exitCode: code });
			});
		});
	},

	"fs.readFile": async ({ path }, ctx) => ({
		base64: (await readFile(absolute(path, ctx.cwd))).toString("base64"),
	}),

	"fs.writeFile": async ({ path, content }, ctx) => {
		await writeFile(absolute(path, ctx.cwd), content, "utf-8");
		return {};
	},

	"fs.mkdir": async ({ path }, ctx) => {
		await mkdir(absolute(path, ctx.cwd), { recursive: true });
		return {};
	},

	"fs.access": async ({ path, mode }, ctx) => {
		await access(absolute(path, ctx.cwd), mode === "rw" ? constants.R_OK | constants.W_OK : constants.R_OK);
		return {};
	},

	"fs.stat": async ({ path }, ctx) => {
		const info = await stat(absolute(path, ctx.cwd));
		return { isDirectory: info.isDirectory(), size: info.size };
	},

	"fs.readdir": async ({ path }, ctx) => ({ entries: await readdir(absolute(path, ctx.cwd)) }),

	"fs.exists": async ({ path }, ctx) => {
		try {
			await access(absolute(path, ctx.cwd), constants.F_OK);
			return { exists: true };
		} catch {
			return { exists: false };
		}
	},

	"fs.glob": async ({ pattern, cwd, ignore, limit }, ctx) => {
		const { glob } = await import("node:fs/promises");
		const paths: string[] = [];
		for await (const entry of glob(pattern, { cwd: absolute(cwd, ctx.cwd), exclude: ignore })) {
			paths.push(typeof entry === "string" ? entry : String(entry));
			if (paths.length >= limit) break;
		}
		return { paths };
	},

	"fs.imageMimeType": async ({ path }) => {
		const lower = path.toLowerCase();
		const match = Object.entries(IMAGE_EXTENSIONS).find(([extension]) => lower.endsWith(extension));
		return { mimeType: match?.[1] ?? null };
	},
};

export async function runOp<K extends RemoteOpName>(op: K, args: RemoteOpArgs<K>, ctx: OpContext): Promise<RemoteOpResult<K>> {
	const handler = handlers[op];
	if (!handler) throw new Error(`unsupported operation: ${op}`);
	return handler(args, ctx);
}

function absolute(path: string, root: string): string {
	const normalized = path.replace(/\\/g, "/");
	const withinRoot =
		normalized === VIRTUAL_ROOT
			? "."
			: normalized.startsWith(`${VIRTUAL_ROOT}/`)
				? normalized.slice(VIRTUAL_ROOT.length + 1)
				: posix.isAbsolute(normalized) || isAbsolute(path)
					? undefined
					: normalized;

	if (withinRoot === undefined) {
		throw new Error(`path is outside the session workspace: ${path}`);
	}

	const resolved = resolve(root, withinRoot);
	const offset = relative(root, resolved);
	if (offset.startsWith(`..${sep}`) || offset === "..") {
		throw new Error(`path escapes the session workspace: ${path}`);
	}
	return resolved;
}
