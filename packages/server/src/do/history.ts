import { Buffer } from "node:buffer";
import { validatePromptImages, type HistoryMessage, type ServerMessage, type StoredEntry } from "@wa/protocol";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripBrief } from "../agent/task-prompt.ts";

/** Replayed tool output is only ever previewed, so it is capped well below the stored size. */
const TOOL_OUTPUT_PREVIEW = 2_000;
export const MAX_HISTORY_FRAME_BYTES = 4 * 1024 * 1024;
type HistoryFrame = Extract<ServerMessage, { t: "history" }>;

/**
 * Projects the persisted entry log into the transcript a client can render.
 *
 * Two things here are deliberate. The operating brief is stripped out of the
 * first user message, so attaching to a session never replays the system
 * prompt. Tool calls and their results are kept, because they are most of what
 * the agent actually did and a transcript without them is unreadable.
 */
export function toHistoryMessages(stored: StoredEntry[]): HistoryMessage[] {
	const messages: HistoryMessage[] = [];

	for (const row of stored) {
		const entry = row.entry as SessionEntry | null;
		if (!entry || typeof entry !== "object" || entry.type !== "message") continue;
		const message = entry.message as Message;

		switch (message.role) {
			case "user": {
				const text = stripBrief(contentText(message.content)).trim();
				const images = validatePromptImages(Array.isArray(message.content)
					? message.content.filter((part) => part.type === "image") : undefined);
				if (text || images.length > 0) messages.push({ k: "user", text, ...(images.length ? { images } : {}) });
				break;
			}
			case "assistant": {
				const text = contentText(message.content).trim();
				if (text) messages.push({ k: "assistant", text });
				for (const part of message.content ?? []) {
					if (part.type === "toolCall") {
						messages.push({ k: "tool_call", toolCallId: part.id, name: part.name, args: part.arguments });
					}
				}
				break;
			}
			case "toolResult":
				messages.push({
					k: "tool_result",
					toolCallId: message.toolCallId,
					name: message.toolName,
					isError: message.isError === true,
					output: truncate(contentText(message.content), TOOL_OUTPUT_PREVIEW),
				});
				break;
			default:
				break;
		}
	}

	return messages;
}

/** Keep images intact while preventing a long transcript from becoming one oversized WS frame. */
export function toHistoryFrames(sessionId: string, stored: StoredEntry[], lastSeq: number): HistoryFrame[] {
	const frames: HistoryFrame[] = [];
	const overhead = Buffer.byteLength(JSON.stringify({ t: "history", sessionId, messages: [], lastSeq, hasMore: false }), "utf-8");
	let messages: HistoryMessage[] = [];
	let bytes = overhead;
	let cursor = stored[0] ? stored[0].seq - 1 : lastSeq;
	for (const row of stored) {
		const projected = toHistoryMessages([row]);
		const added = projected.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message), "utf-8") + 1, 0);
		if (overhead + added > MAX_HISTORY_FRAME_BYTES) throw new Error(`History entry ${row.seq} exceeds the replay frame limit.`);
		if (messages.length > 0 && bytes + added > MAX_HISTORY_FRAME_BYTES) {
			frames.push({ t: "history", sessionId, messages, lastSeq: cursor, hasMore: true });
			messages = [];
			bytes = overhead;
		}
		messages.push(...projected);
		bytes += added;
		cursor = row.seq;
	}
	frames.push({ t: "history", sessionId, messages, lastSeq, hasMore: false });
	return frames;
}

function contentText(content: string | readonly { type: string }[] | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content as readonly (TextContent | ImageContent)[]) {
		if (part.type === "text") text += part.text;
	}
	return text;
}

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
}
