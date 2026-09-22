import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentService } from "./agent-service.ts";
import { HttpError, MAX_REQUEST_BYTES, type MessageRequest } from "./contracts.ts";
import { staticAsset } from "./static-site.ts";

const ROUTE = /^\/v1\/sessions\/([^/]+)\/messages$/;

export function createHttpHandler(service: Pick<AgentService, "message">) {
	return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		try {
			const path = new URL(request.url ?? "/", "http://localhost").pathname;
			if (request.method === "GET") {
				const asset = await staticAsset(path);
				if (!asset) throw new HttpError(404, "NOT_FOUND", "Not found.");
				response.writeHead(200, {
					"content-type": asset.contentType, "content-length": asset.body.length,
					"cache-control": "no-store",
				});
				response.end(asset.body);
				return;
			}
			const match = ROUTE.exec(path);
			if (request.method !== "POST" || !match?.[1]) throw new HttpError(404, "NOT_FOUND", "Not found.");
			if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
				throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
			}
			const body = await readJson(request);
			const result = await service.message(decodeURIComponent(match[1]), body as MessageRequest);
			sendJson(response, 200, result);
		} catch (error) {
			const failure = error instanceof HttpError ? error : new HttpError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
			sendJson(response, failure.status, { error: { code: failure.code, message: failure.message } });
		}
	};
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const declared = Number(request.headers["content-length"]);
	if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
		throw new HttpError(413, "REQUEST_TOO_LARGE", "JSON request must not exceed 8 MiB.");
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_REQUEST_BYTES) throw new HttpError(413, "REQUEST_TOO_LARGE", "JSON request must not exceed 8 MiB.");
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
	}
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) });
	response.end(json);
}
