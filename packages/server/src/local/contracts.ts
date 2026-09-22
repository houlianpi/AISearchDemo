export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export interface MessageRequest {
	prompt: string;
	image?: { url: string } | { mimeType: ImageMimeType; data: string };
}

export interface ImageAnalysis {
	description: string;
	keywords: string[];
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	thumbnailUrl?: string;
	source: string;
}

export interface MessageResponse {
	sessionId: string;
	answer: string;
	imageAnalysis: ImageAnalysis | null;
	searchResults: SearchResult[];
	searchMode: "live" | "demo-fallback" | "not-used" | "unavailable";
}

export class HttpError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}
