import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	clientMessageByteLimit,
	type ClientMessage,
	type HistoryMessage,
	imageByteLength,
	PROTOCOL_VERSION,
	type PromptImageLimits,
	type RemoteOpName,
	type ServerMessage,
	type SessionSummary,
} from "@wa/protocol";
import WebSocket from "ws";
import { runOp } from "./local-ops.ts";
import { prepareImagePrompt, prepareImagesPrompt } from "./image-prompt.ts";

/**
 * Headless client: stdin/stdout instead of a TUI.
 *
 * The agent itself runs on Cloudflare; this process only feeds it prompts,
 * renders its output, and executes the tools it asks for.
 */

// Optional packages/client/.env for local defaults. Shell variables win over it.
try {
	process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
	// No .env file; rely on the shell environment.
}

const SERVER_URL = process.env.WA_SERVER_URL ?? "ws://127.0.0.1:8787/ws";
const USER_ID = process.env.WA_USER_ID ?? "dev-user";
const CWD = process.env.WA_CWD ?? process.cwd();

const pendingAcks = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
const runningOps = new Map<string, AbortController>();
let activeSessionId: string | undefined;
let requestCounter = 0;
let imageLimits: PromptImageLimits | undefined;

const socket = new WebSocket(SERVER_URL, { headers: { "X-User-Id": USER_ID } });

socket.on("open", () => {
	send({ t: "hello", protocolVersion: PROTOCOL_VERSION, cwd: CWD, clientInfo: `node ${process.version}` });
});

socket.on("message", (data) => {
	let message: ServerMessage;
	try {
		message = JSON.parse(data.toString()) as ServerMessage;
	} catch {
		return;
	}
	void handle(message);
});

socket.on("close", () => {
	process.stdout.write("\n[disconnected]\n");
	process.exit(0);
});

socket.on("error", (error) => {
	process.stderr.write(`[socket error] ${error.message}\n`);
	process.exit(1);
});

async function handle(message: ServerMessage): Promise<void> {
	switch (message.t) {
		case "ready":
			imageLimits = message.capabilities?.promptImages;
			process.stdout.write(`connected as ${message.userId} (max ${message.maxConcurrentTurns} concurrent sessions)\n`);
			await bootstrap(message.sessions);
			return;

		case "ack": {
			const pending = pendingAcks.get(message.id);
			if (!pending) return;
			pendingAcks.delete(message.id);
			if (message.ok) pending.resolve(message.data);
			else pending.reject(new Error(message.error));
			return;
		}

		case "history":
			if (message.messages.length > 0) {
				process.stdout.write(`\n--- history (${message.messages.length} messages) ---\n`);
				for (const entry of message.messages) renderHistory(entry);
				process.stdout.write("--- end of history ---\n");
			}
			return;

		case "stream":
			for (const event of message.events) render(event);
			return;

		case "session.updated":
			return;

		case "op.call": {
			const controller = new AbortController();
			runningOps.set(message.callId, controller);
			try {
				const result = await runOp(message.op as RemoteOpName, message.args, {
					cwd: CWD,
					signal: controller.signal,
					onUpdate: (chunk) => send({ t: "op.update", callId: message.callId, base64: chunk.toString("base64") }),
				});
				send({ t: "op.result", callId: message.callId, ok: true, result });
			} catch (error) {
				send({
					t: "op.result",
					callId: message.callId,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				runningOps.delete(message.callId);
			}
			return;
		}

		case "op.abort":
			runningOps.get(message.callId)?.abort();
			return;

		case "fatal":
			process.stderr.write(`[server] ${message.message}\n`);
			return;
	}
}

async function bootstrap(sessions: SessionSummary[]): Promise<void> {
	const latest = sessions[0];
	if (latest) {
		await request({ t: "session.attach", id: nextId(), sessionId: latest.sessionId });
		activeSessionId = latest.sessionId;
		process.stdout.write(`resumed session ${latest.sessionId} (${latest.title ?? "untitled"})\n`);
	} else {
		await newSession();
	}
	printHelp();
	prompt();
}

async function newSession(): Promise<void> {
	const data = (await request({ t: "session.create", id: nextId(), cwd: CWD })) as { session: SessionSummary };
	activeSessionId = data.session.sessionId;
	process.stdout.write(`new session ${activeSessionId}\n`);
}

const rl = createInterface({ input: process.stdin, terminal: false });
let inputQueue = Promise.resolve();

rl.on("line", (line) => {
	const text = line.trim();
	// Interrupts must not wait behind a file read or a delayed acknowledgement.
	if (text === "/abort" || text === "/quit" || text === "/exit") {
		void onLine(text);
		return;
	}
	inputQueue = inputQueue.then(() => onLine(text));
});

async function onLine(line: string): Promise<void> {
	try {
		if (!line) return prompt();
		if (line === "/quit" || line === "/exit") {
			socket.close();
			return;
		}
		if (line === "/help") {
			printHelp();
			return prompt();
		}
		if (line === "/new") {
			await newSession();
			return prompt();
		}
		if (line === "/abort") {
			if (activeSessionId) await request({ t: "abort", id: nextId(), sessionId: activeSessionId });
			return prompt();
		}
		if (line === "/sessions") {
			const data = (await request({ t: "session.list", id: nextId() })) as { sessions: SessionSummary[] };
			for (const session of data.sessions) {
				const marker = session.sessionId === activeSessionId ? "*" : " ";
				process.stdout.write(`${marker} ${session.sessionId}  ${session.title ?? "untitled"}\n`);
			}
			return prompt();
		}
		if (line.startsWith("/attach ")) {
			const sessionId = line.slice("/attach ".length).trim();
			await request({ t: "session.attach", id: nextId(), sessionId });
			activeSessionId = sessionId;
			return prompt();
		}

		if (!activeSessionId) {
			process.stderr.write("no active session\n");
			return prompt();
		}
		const imageCommand = /^\/(image|images)(?:\s|$)/.exec(line);
		if (imageCommand) {
			if (!imageLimits) throw new Error("This server does not advertise image prompts. Update the server first.");
			const prepare = imageCommand[1] === "images" ? prepareImagesPrompt : prepareImagePrompt;
			const input = await prepare(line.slice(imageCommand[0].length), CWD, imageLimits);
			await request({ t: "prompt", id: nextId(), sessionId: activeSessionId, text: input.text, images: input.images });
			return;
		}
		await request({ t: "prompt", id: nextId(), sessionId: activeSessionId, text: line });
	} catch (error) {
		process.stderr.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`);
		prompt();
	}
}

function render(event: import("@wa/protocol").AgentStreamEvent): void {
	switch (event.k) {
		case "text_delta":
			process.stdout.write(event.text);
			return;
		case "thinking_delta":
			return;
		case "tool_start":
			process.stdout.write(`\n  · ${event.name} ${summarise(event.args)}\n`);
			return;
		case "tool_end":
			process.stdout.write(`  ${event.isError ? "✗" : "✓"} ${event.name}`);
			process.stdout.write(event.isError ? `: ${event.output.split("\n")[0]}\n` : "\n");
			return;
		case "agent_end":
			process.stdout.write(`\n[tokens in=${event.usage?.input ?? 0} out=${event.usage?.output ?? 0}]\n`);
			prompt();
			return;
		case "message_end":
			if (event.role === "assistant" && event.errorMessage) {
				process.stderr.write(`\n[model error] ${event.errorMessage}\n`);
			}
			return;
		case "error":
			process.stderr.write(`\n[agent error] ${event.message}\n`);
			return;
		default:
			return;
	}
}

function summarise(args: unknown): string {
	const text = typeof args === "string" ? args : JSON.stringify(args);
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function renderHistory(message: HistoryMessage): void {
	switch (message.k) {
		case "user":
			process.stdout.write(`\n> ${message.text}\n`);
			for (const [index, image] of (message.images ?? []).entries()) {
				process.stdout.write(`  [image ${index + 1}: ${image.mimeType}, ${imageByteLength(image.data)} bytes]\n`);
			}
			return;
		case "assistant":
			process.stdout.write(`${message.text}\n`);
			return;
		case "tool_call":
			process.stdout.write(`  · ${message.name} ${summarise(message.args)}\n`);
			return;
		case "tool_result":
			process.stdout.write(`  ${message.isError ? "✗" : "✓"} ${message.name}`);
			process.stdout.write(message.isError ? `: ${message.output.split("\n")[0]}\n` : "\n");
			return;
	}
}

function request(message: ClientMessage & { id: string }): Promise<unknown> {
	return new Promise((resolve, reject) => {
		pendingAcks.set(message.id, { resolve, reject });
		try {
			send(message);
		} catch (error) {
			pendingAcks.delete(message.id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function send(message: ClientMessage): void {
	const json = JSON.stringify(message);
	let limit = clientMessageByteLimit(message);
	if (message.t === "prompt" && message.images?.length && imageLimits) {
		limit = Math.min(limit, imageLimits.maxPromptBytes);
	}
	if (!Number.isFinite(limit) || Buffer.byteLength(json, "utf-8") > limit) {
		throw new Error(`Message exceeds the ${limit}-byte limit. Reduce the text or image sizes.`);
	}
	socket.send(json);
}

function nextId(): string {
	return `req-${++requestCounter}`;
}

function prompt(): void {
	process.stdout.write("\n> ");
}

function printHelp(): void {
	process.stdout.write('commands: /new  /sessions  /attach <id>  /image "<path>" [question]  /images "<path1>" "<path2>" -- [question]  /abort  /help  /quit\n');
}
