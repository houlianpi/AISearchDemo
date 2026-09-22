import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { parseHTML } from "linkedom";
import type { SearchResult } from "./contracts.ts";

const ENRICHED_RESULT_COUNT = 3;
const FETCH_TIMEOUT_MS = 4_000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

const blocked = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
	["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
	["ff00::", 8], ["2001:db8::", 32],
] as const) blocked.addSubnet(network, prefix, "ipv6");

type ResolveHost = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

export interface MetadataOptions {
	fetcher?: typeof fetch;
	resolveHost?: ResolveHost;
	timeoutMs?: number;
	maxBytes?: number;
}

export async function enrichTopSearchResults(
	results: readonly SearchResult[],
	options: MetadataOptions = {},
): Promise<SearchResult[]> {
	const head = results.slice(0, ENRICHED_RESULT_COUNT).map(async (result) => {
		try {
			return await enrichResult(result, options);
		} catch {
			return result;
		}
	});
	return [...await Promise.all(head), ...results.slice(ENRICHED_RESULT_COUNT)];
}

export async function assertPublicHttpUrl(url: URL, resolveHost: ResolveHost = defaultResolveHost): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are allowed.");
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
		throw new Error("Local and internal hosts are not allowed.");
	}
	const literalFamily = isIP(hostname);
	const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await resolveHost(hostname);
	if (addresses.length === 0 || addresses.some(({ address, family }) => isBlockedAddress(address, family))) {
		throw new Error("The URL resolves to a non-public address.");
	}
}

function isBlockedAddress(address: string, family: number): boolean {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	return mapped ? blocked.check(mapped, "ipv4") : blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

async function enrichResult(result: SearchResult, options: MetadataOptions): Promise<SearchResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
	try {
		const fetched = await fetchHtmlFollowingRedirects(
			new URL(result.url), options.fetcher ?? fetch, options.resolveHost ?? defaultResolveHost, controller.signal, options.maxBytes ?? MAX_HTML_BYTES,
		);
		if (!fetched) return result;
		const metadata = parsePageMetadata(fetched.html, fetched.url);
		await removeUnsafeAssetUrls(metadata, options.resolveHost ?? defaultResolveHost);
		return { ...result, ...metadata };
	} finally {
		clearTimeout(timer);
	}
}

async function removeUnsafeAssetUrls(metadata: Partial<SearchResult>, resolveHost: ResolveHost): Promise<void> {
	for (const key of ["faviconUrl", "thumbnailUrl"] as const) {
		const value = metadata[key];
		if (!value) continue;
		try { await assertPublicHttpUrl(new URL(value), resolveHost); }
		catch { delete metadata[key]; }
	}
}

async function fetchHtmlFollowingRedirects(
	initialUrl: URL, fetcher: typeof fetch, resolveHost: ResolveHost, signal: AbortSignal, maxBytes: number,
): Promise<{ html: string; url: URL } | undefined> {
	let url = initialUrl;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		await assertPublicHttpUrl(url, resolveHost);
		const response = await fetcher(url, {
			method: "GET", redirect: "manual", signal,
			headers: { accept: "text/html,application/xhtml+xml", "user-agent": "AISearchDemo/1.0 metadata preview" },
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location || redirects === MAX_REDIRECTS) return undefined;
			url = new URL(location, url);
			continue;
		}
		if (!response.ok || !response.body || !(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return undefined;
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maxBytes) return undefined;
		const html = await readBoundedText(response.body, maxBytes);
		return html === undefined ? undefined : { html, url };
	}
	return undefined;
}

async function readBoundedText(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string | undefined> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();
		size += value.byteLength;
		if (size > maxBytes) { await reader.cancel(); return undefined; }
		text += decoder.decode(value, { stream: true });
	}
}

export function parsePageMetadata(html: string, baseUrl: URL): Partial<SearchResult> {
	const { document } = parseHTML(html);
	const meta = new Map<string, string>();
	for (const element of document.querySelectorAll("meta")) {
		const key = (element.getAttribute("property") ?? element.getAttribute("name") ?? "").toLowerCase();
		const value = element.getAttribute("content")?.trim();
		if (key && value && !meta.has(key)) meta.set(key, value);
	}

	const jsonLd = jsonLdNodes(document).flatMap(flattenJsonLd);
	const video = jsonLd.find((value) => hasJsonLdType(value, "VideoObject"));
	const article = jsonLd.find((value) => ["Article", "NewsArticle", "BlogPosting"].some((type) => hasJsonLdType(value, type)));
	const primary = video ?? article;
	const favicon = [...document.querySelectorAll("link[rel]")].find((link) => {
		const rel = (link.getAttribute("rel") ?? "").toLowerCase();
		return rel.split(/\s+/).includes("icon") || rel.includes("apple-touch-icon");
	})?.getAttribute("href");
	const image = meta.get("og:image") ?? stringFromJsonLd(primary?.thumbnailUrl) ?? stringFromJsonLd(primary?.image);
	const author = meta.get("author") ?? meta.get("article:author") ?? authorFromJsonLd(primary?.author);
	const publishedAt = meta.get("article:published_time") ?? stringFromJsonLd(primary?.datePublished);
	const duration = video ? formatIsoDuration(stringFromJsonLd(video.duration)) : undefined;

	return compact({
		title: meta.get("og:title"),
		snippet: meta.get("og:description") ?? meta.get("description"),
		sourceName: meta.get("og:site_name"),
		faviconUrl: absoluteUrl(favicon, baseUrl),
		thumbnailUrl: absoluteUrl(image, baseUrl),
		publishedAt, author, duration,
		contentType: video ? "video" : article ? "article" : "page",
	});
}

function jsonLdNodes(document: Document): Record<string, unknown>[] {
	const values: Record<string, unknown>[] = [];
	for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
		try {
			const parsed: unknown = JSON.parse(script.textContent ?? "");
			if (Array.isArray(parsed)) values.push(...parsed.filter(isRecord));
			else if (isRecord(parsed)) values.push(parsed);
		} catch {}
	}
	return values;
}

function flattenJsonLd(value: Record<string, unknown>): Record<string, unknown>[] {
	const graph = value["@graph"];
	return [value, ...(Array.isArray(graph) ? graph.filter(isRecord) : [])];
}

function hasJsonLdType(value: Record<string, unknown>, type: string): boolean {
	const candidate = value["@type"];
	return candidate === type || (Array.isArray(candidate) && candidate.includes(type));
}

function authorFromJsonLd(value: unknown): string | undefined {
	const first = Array.isArray(value) ? value[0] : value;
	if (typeof first === "string") return first;
	return isRecord(first) && typeof first.name === "string" ? first.name : undefined;
}

function stringFromJsonLd(value: unknown): string | undefined {
	const first = Array.isArray(value) ? value[0] : value;
	if (typeof first === "string") return first;
	return isRecord(first) && typeof first.url === "string" ? first.url : undefined;
}

function absoluteUrl(value: string | null | undefined, baseUrl: URL): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value, baseUrl);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch { return undefined; }
}

function formatIsoDuration(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(value);
	if (!match) return value;
	const hours = Number(match[1] ?? 0);
	const minutes = Number(match[2] ?? 0);
	const seconds = Number(match[3] ?? 0);
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function compact<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultResolveHost(hostname: string): Promise<readonly { address: string; family: number }[]> {
	return lookup(hostname, { all: true, verbatim: true });
}
