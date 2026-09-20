export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export interface PromptImage {
	mimeType: ImageMimeType;
	/** Standard Base64 only, without a data: URL prefix or whitespace. */
	data: string;
}

export interface PromptImageLimits {
	mimeTypes: readonly ImageMimeType[];
	maxImages: number;
	maxImageBytes: number;
	maxTotalImageBytes: number;
	maxPromptBytes: number;
}

export const MAX_CLIENT_MESSAGE_BYTES = 1_000_000;
/** Leaves room for the operating brief and entry metadata below the 1.5 MB storage guard. */
export const IMAGE_PROMPT_LIMITS: PromptImageLimits = {
	mimeTypes: IMAGE_MIME_TYPES,
	maxImages: 4,
	maxImageBytes: 768 * 1024,
	maxTotalImageBytes: 768 * 1024,
	maxPromptBytes: 1_250_000,
};

export interface PromptInput {
	text: string;
	images: PromptImage[];
	streamingBehavior?: "steer" | "followUp";
}

export function clientMessageByteLimit(message: { t: unknown; images?: unknown }): number {
	return message.t === "prompt" && Array.isArray(message.images) && message.images.length > 0
		? IMAGE_PROMPT_LIMITS.maxPromptBytes : MAX_CLIENT_MESSAGE_BYTES;
}

export function isImageMimeType(value: unknown): value is ImageMimeType {
	return IMAGE_MIME_TYPES.some((mime) => mime === value);
}

/** Signature detection only; full image decoding remains the provider's responsibility. */
export function detectImageMimeType(bytes: Uint8Array): ImageMimeType | undefined {
	if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
	if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
	return undefined;
}

/** Call only after validating the standard Base64 representation. */
export function imageByteLength(data: string): number {
	return data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export function validatePromptImages(value: unknown): PromptImage[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("images must be an array.");
	if (value.length > IMAGE_PROMPT_LIMITS.maxImages) {
		throw new Error(`At most ${IMAGE_PROMPT_LIMITS.maxImages} images are allowed per prompt.`);
	}
	const images: PromptImage[] = [];
	let total = 0;
	const candidates: readonly unknown[] = value;
	for (const [index, image] of candidates.entries()) {
		if (!image || typeof image !== "object" ||
			!("mimeType" in image) || !isImageMimeType(image.mimeType) ||
			!("data" in image) || typeof image.data !== "string") {
			throw new Error(`images[${index}] must contain a supported mimeType and Base64 data.`);
		}
		const data: string = image.data;
		if (data.length > Math.ceil(IMAGE_PROMPT_LIMITS.maxImageBytes / 3) * 4) {
			throw new Error(`images[${index}] exceeds the ${IMAGE_PROMPT_LIMITS.maxImageBytes}-byte image limit.`);
		}
		if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
			throw new Error(`images[${index}].data must be standard Base64 without a data: prefix or whitespace.`);
		}
		if ((data.endsWith("==") && (BASE64_ALPHABET.indexOf(data.charAt(data.length - 3)) & 15) !== 0) ||
			(data.endsWith("=") && !data.endsWith("==") && (BASE64_ALPHABET.indexOf(data.charAt(data.length - 2)) & 3) !== 0)) {
			throw new Error(`images[${index}].data has invalid Base64 padding bits.`);
		}
		const bytes = imageByteLength(data);
		total += bytes;
		if (bytes > IMAGE_PROMPT_LIMITS.maxImageBytes || total > IMAGE_PROMPT_LIMITS.maxTotalImageBytes) {
			throw new Error(`Combined images exceed the ${IMAGE_PROMPT_LIMITS.maxTotalImageBytes}-byte prompt limit.`);
		}
		const header = Uint8Array.from(atob(data.slice(0, 32)), (char) => char.charCodeAt(0));
		if (detectImageMimeType(header) !== image.mimeType) {
			throw new Error(`images[${index}].mimeType does not match the image signature.`);
		}
		images.push({ mimeType: image.mimeType, data });
	}
	return images;
}

export function parsePromptInput(value: { text?: unknown; images?: unknown; streamingBehavior?: unknown }): PromptInput {
	if (value.text !== undefined && typeof value.text !== "string") throw new Error("text must be a string.");
	const text = value.text ?? "";
	const images = validatePromptImages(value.images);
	if (!text.trim() && images.length === 0) throw new Error("A prompt needs text or at least one image.");
	const behavior = value.streamingBehavior;
	if (behavior !== undefined && behavior !== "steer" && behavior !== "followUp") {
		throw new Error('streamingBehavior must be "steer" or "followUp".');
	}
	return { text, images, streamingBehavior: behavior };
}
