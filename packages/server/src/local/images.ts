import { Buffer } from "node:buffer";
import type { ImageContent } from "@earendil-works/pi-ai";
import { HttpError, IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, type ImageMimeType } from "./contracts.ts";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export async function resolveImage(value: unknown, fetcher: typeof fetch = fetch): Promise<ImageContent | undefined> {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(400, "INVALID_IMAGE", "image must be an object.");
	}
	const image = value as Record<string, unknown>;
	const hasUrl = typeof image.url === "string";
	const hasData = typeof image.data === "string" || typeof image.mimeType === "string";
	if (hasUrl === hasData) {
		throw new HttpError(400, "INVALID_IMAGE", "image must contain either url, or mimeType and data.");
	}

	if (hasUrl) return fetchImage(image.url as string, fetcher);
	if (typeof image.data !== "string" || !isImageMimeType(image.mimeType)) {
		throw new HttpError(400, "INVALID_IMAGE", "image.mimeType and image.data are required.");
	}
	const data = image.data;
	if (!data || data.length % 4 !== 0 || !BASE64.test(data)) {
		throw new HttpError(400, "INVALID_IMAGE_BASE64", "image.data must be standard Base64 without a data URL prefix or whitespace.");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) {
		throw new HttpError(400, "INVALID_IMAGE_BASE64", "image.data must use canonical Base64 encoding.");
	}
	if (bytes.length > MAX_IMAGE_BYTES) throw imageTooLarge();
	validateSignature(bytes, image.mimeType);
	return { type: "image", mimeType: image.mimeType, data };
}

async function fetchImage(urlText: string, fetcher: typeof fetch): Promise<ImageContent> {
	let url: URL;
	try {
		url = new URL(urlText);
	} catch {
		throw new HttpError(400, "INVALID_IMAGE_URL", "image.url must be an absolute HTTP(S) URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new HttpError(400, "INVALID_IMAGE_URL", "image.url must use HTTP or HTTPS.");
	}
	let response: Response;
	try {
		response = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
	} catch (error) {
		throw new HttpError(400, "IMAGE_FETCH_FAILED", `Could not fetch image: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok || !response.body) {
		throw new HttpError(400, "IMAGE_FETCH_FAILED", `Image URL returned HTTP ${response.status}.`);
	}
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw imageTooLarge();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > MAX_IMAGE_BYTES) {
			await reader.cancel();
			throw imageTooLarge();
		}
		chunks.push(value);
	}
	const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
	const mimeType = detectMimeType(bytes);
	if (!mimeType) throw new HttpError(400, "UNSUPPORTED_IMAGE", "Image must be JPEG, PNG, or WebP.");
	return { type: "image", mimeType, data: bytes.toString("base64") };
}

function imageTooLarge(): HttpError {
	return new HttpError(413, "IMAGE_TOO_LARGE", "Image must not exceed 5 MiB.");
}

function isImageMimeType(value: unknown): value is ImageMimeType {
	return typeof value === "string" && IMAGE_MIME_TYPES.some((type) => type === value);
}

function validateSignature(bytes: Uint8Array, expected: ImageMimeType): void {
	if (detectMimeType(bytes) !== expected) {
		throw new HttpError(400, "IMAGE_MIME_MISMATCH", "image.mimeType does not match the image signature.");
	}
}

export function detectMimeType(bytes: Uint8Array): ImageMimeType | undefined {
	if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
	return undefined;
}
