import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const LOCAL_VARS = fileURLToPath(new URL("../packages/server/.dev.vars", import.meta.url));
const DEFAULT_QUESTION = "这张图片里有什么？请用中文描述。";

async function loadKey() {
	const supplied = process.env.DEEPSEEK_API_KEY?.trim();
	if (supplied) return { key: supplied, source: "DEEPSEEK_API_KEY environment variable" };
	let local;
	try {
		local = parseEnv(await readFile(LOCAL_VARS, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const key = local?.DEEPSEEK_API_KEY?.trim();
	if (!key || key === "sk-replace-me") {
		throw new Error(`Set DEEPSEEK_API_KEY in the environment or in ${LOCAL_VARS}.`);
	}
	return { key, source: LOCAL_VARS };
}

function imageMime(bytes) {
	if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
	throw new Error("Unsupported image contents. Expected WebP, PNG, JPEG or GIF.");
}

export async function main(args = process.argv.slice(2)) {
	if (args[0] === "--help" || args[0] === "-h") {
		console.log("Usage: node scripts\\deepseek-vision.mjs [image-path] [question]");
		console.log("Defaults: Downloads\\123.webp; key loaded from the environment or packages\\server\\.dev.vars.");
		return;
	}
	if (args.length > 2) throw new Error("Expected at most an image path and one quoted question. Use --help.");

	const imagePath = resolve(args[0] ?? join(homedir(), "Downloads", "123.webp"));
	const question = args[1] ?? DEFAULT_QUESTION;
	if (!question.trim()) throw new Error("The question must not be empty.");
	const image = await readFile(imagePath);
	const mime = imageMime(image);
	const base64 = image.toString("base64");
	const { key, source: keySource } = await loadKey();
	const redact = (text) => text.replaceAll(key, "[REDACTED]");

	try {
		const base = new URL(process.env.DEEPSEEK_BASE_URL ?? "https://ds.buildnow.work/v1");
		if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
			throw new Error("DEEPSEEK_BASE_URL must be an HTTPS base URL without credentials, query or fragment.");
		}
		const endpoint = base.href.replace(/\/+$/, "") + "/chat/completions";
		const payload = {
			model: process.env.DEEPSEEK_DEFAULT_MODEL ?? "deepseek-v4-flash",
			thinking: { type: "enabled" },
			reasoning_effort: "medium",
			max_tokens: 2048,
			stream: false,
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: question },
					{ type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
				],
			}],
		};

		console.log("--- Request summary (key and Base64 omitted from console) ---");
		console.log(redact(JSON.stringify({
			endpoint,
			model: payload.model,
			reasoning_effort: payload.reasoning_effort,
			imagePath,
			mime,
			imageBytes: image.length,
			base64Characters: base64.length,
			imageSha256: createHash("sha256").update(image).digest("hex"),
			keySource,
			question,
		}, null, 2)));

		const started = performance.now();
		const response = await fetch(endpoint, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(90_000),
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		const raw = await response.text();
		console.log(`\nHTTP ${response.status}; elapsed ${Math.round(performance.now() - started)} ms`);
		console.log("--- Raw DeepSeek response ---");
		console.log(redact(raw));
		if (!response.ok) throw new Error(`DeepSeek returned HTTP ${response.status}; see the response above.`);

		const body = JSON.parse(raw);
		const choice = body?.choices?.[0];
		if (choice?.finish_reason === "length") {
			throw new Error("Response reached max_tokens=2048 and may be incomplete; see the raw response.");
		}
		if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) {
			throw new Error("DeepSeek returned no final text; see the raw response.");
		}
		console.log("\n--- Model answer ---");
		console.log(redact(choice.message.content));
		return body;
	} catch (error) {
		throw new Error(redact(error instanceof Error ? error.message : String(error)));
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(`[error] ${error.message}`);
		process.exitCode = 1;
	});
}
