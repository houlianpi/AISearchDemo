import type { HistoryMessage, StoredEntry } from "@wa/protocol";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripBrief } from "../agent/task-prompt.ts";

/** Replayed tool output is only ever previewed, so it is capped well below the stored size. */
const TOOL_OUTPUT_PREVIEW = 2_000;

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
				if (text) messages.push({ k: "user", text });
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
