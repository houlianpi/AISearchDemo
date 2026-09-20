import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	detectImageMimeType,
	IMAGE_PROMPT_LIMITS,
	imageByteLength,
	parsePromptInput,
	type PromptImageLimits,
	type PromptInput,
} from "@wa/protocol";

export async function prepareImagePrompt(
	args: string,
	cwd: string,
	limits: PromptImageLimits = IMAGE_PROMPT_LIMITS,
): Promise<PromptInput> {
	const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([\s\S]*))?$/.exec(args.trim());
	const path = match?.[1] ?? match?.[2] ?? match?.[3];
	if (!path) throw new Error('Usage: /image "<image path>" [question]');
	return loadImages([path], match?.[4] ?? "", cwd, limits);
}

export async function prepareImagesPrompt(
	args: string,
	cwd: string,
	limits: PromptImageLimits = IMAGE_PROMPT_LIMITS,
): Promise<PromptInput> {
	const paths: string[] = [];
	let rest = args.trim();
	let text = "";
	while (rest) {
		if (/^--(?:\s|$)/.test(rest)) {
			text = rest.slice(2).trim();
			break;
		}
		const match = /^(?:"([^"]+)"|'([^']+)'|([^"'\s]+))(?:\s+|$)/.exec(rest);
		const path = match?.[1] ?? match?.[2] ?? match?.[3];
		if (!match || !path) throw new Error('Usage: /images "<path1>" "<path2>" -- [question]');
		paths.push(path);
		rest = rest.slice(match[0].length);
	}
	if (paths.length === 0) throw new Error('Usage: /images "<path1>" "<path2>" -- [question]');
	return loadImages(paths, text, cwd, limits);
}

async function loadImages(paths: string[], text: string, cwd: string, limits: PromptImageLimits): Promise<PromptInput> {
	const maxImages = Math.min(IMAGE_PROMPT_LIMITS.maxImages, limits.maxImages);
	const maxTotal = Math.min(IMAGE_PROMPT_LIMITS.maxTotalImageBytes, limits.maxTotalImageBytes);
	const maxBytes = Math.min(IMAGE_PROMPT_LIMITS.maxImageBytes, limits.maxImageBytes, maxTotal);
	if (![maxImages, maxTotal, maxBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
		throw new Error("The server did not advertise valid image upload limits.");
	}
	if (paths.length > maxImages) throw new Error(`At most ${maxImages} images are allowed per prompt.`);
	const files = paths.map((path) => resolve(cwd, path));
	const sizes = await Promise.all(files.map(async (file) => {
		const info = await stat(file);
		if (!info.isFile()) throw new Error("Each image path must point to a file.");
		if (info.size > maxBytes) throw new Error(`Image exceeds ${maxBytes} bytes. Resize or compress it before sending.`);
		return info.size;
	}));
	if (sizes.reduce((sum, size) => sum + size, 0) > maxTotal) {
		throw new Error(`Combined images exceed ${maxTotal} bytes. Resize or compress them before sending.`);
	}
	const images = await Promise.all(files.map(async (file) => {
		const bytes = await readFile(file);
		if (bytes.length > maxBytes) throw new Error(`Image exceeds ${maxBytes} bytes. Resize or compress it before sending.`);
		const mimeType = detectImageMimeType(bytes);
		if (!mimeType || !limits.mimeTypes.includes(mimeType)) {
			throw new Error("Unsupported image contents. Use a server-supported PNG, JPEG, WebP or GIF.");
		}
		return { mimeType, data: bytes.toString("base64") };
	}));
	const result = parsePromptInput({ text, images });
	if (images.reduce((sum, image) => sum + imageByteLength(image.data), 0) > maxTotal) {
		throw new Error(`Combined images exceed ${maxTotal} bytes. Resize or compress them before sending.`);
	}
	return result;
}
