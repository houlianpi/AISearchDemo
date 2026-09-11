import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Structural analysis of a captured HTML page, computed inside the Worker.
 *
 * Captured pages arrive as one minified line of a few hundred KB, which pi's
 * `read` tool refuses and which shell one-liners cannot inspect portably (the
 * client shell is PowerShell on Windows, bash elsewhere). Doing it here keeps
 * the model out of that rabbit hole: only the file bytes cross the RPC, the
 * parsing is pure computation.
 */

const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

/** Contents are markup-irrelevant and must never be counted as page text. */
const OPAQUE_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);

const CHROME_TAGS = new Set(["header", "nav", "footer", "aside"]);

const CHROME_WORDS = new Set([
	"nav",
	"navi",
	"navbar",
	"menu",
	"foot",
	"footer",
	"bottom",
	"sidebar",
	"aside",
	"banner",
	"ad",
	"ads",
	"advert",
	"login",
	"signin",
	"toolbar",
	"tabbar",
	"breadcrumb",
	"copyright",
	"beian",
	"icp",
	"legal",
	"searchbox",
	"searchbar",
	"cookie",
	"modal",
	"popup",
	"dialog",
	"overlay",
]);

const MAIN_WORDS = new Set(["main", "content", "article", "list", "feed", "result", "results", "container"]);

/** `s-hotsearch-wrapper-no-login` is content, not a login widget. */
const NEGATORS = new Set(["no", "not", "non", "un", "without"]);

function hasWord(value: string, words: Set<string>): boolean {
	const segments = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	return segments.some((segment, index) => words.has(segment) && !NEGATORS.has(segments[index - 1] ?? ""));
}

function names(node: Node): string[] {
	return node.id ? [node.id, ...node.classes] : node.classes;
}

interface Node {
	tag: string;
	id: string;
	classes: string[];
	parent: Node | undefined;
	children: Node[];
	/** Byte-agnostic offsets into the source string, for `slice` follow-ups. */
	start: number;
	end: number;
	text: string;
	depth: number;
	cachedText?: string;
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

function parse(html: string): Node {
	const root: Node = {
		tag: "#root",
		id: "",
		classes: [],
		parent: undefined,
		children: [],
		start: 0,
		end: html.length,
		text: "",
		depth: 0,
	};
	const stack: Node[] = [root];
	let cursor = 0;
	let match: RegExpExecArray | null;

	TAG_RE.lastIndex = 0;
	while ((match = TAG_RE.exec(html)) !== null) {
		const [raw, closing, rawTag, rawAttrs, selfClosing] = match;
		const tag = (rawTag ?? "").toLowerCase();
		const top = stack[stack.length - 1];
		if (!top) break;

		if (match.index > cursor) addText(top, html.slice(cursor, match.index));
		cursor = match.index + raw.length;

		if (closing) {
			// Tolerate unbalanced markup: unwind to the nearest matching open tag only.
			for (let depth = stack.length - 1; depth > 0; depth--) {
				const candidate = stack[depth];
				if (!candidate) break;
				if (candidate.tag === tag) {
					candidate.end = cursor;
					stack.length = depth;
					break;
				}
			}
			continue;
		}

		if (OPAQUE_TAGS.has(tag)) {
			const close = html.indexOf(`</${tag}`, cursor);
			cursor = close === -1 ? html.length : (html.indexOf(">", close) + 1 || html.length);
			TAG_RE.lastIndex = cursor;
			continue;
		}

		const node: Node = {
			tag,
			id: attr(rawAttrs ?? "", "id"),
			classes: attr(rawAttrs ?? "", "class").split(/\s+/).filter(Boolean),
			parent: top,
			children: [],
			start: match.index,
			end: cursor,
			text: "",
			depth: top.depth + 1,
		};
		top.children.push(node);
		if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
	}

	const last = stack[stack.length - 1];
	if (last && cursor < html.length) addText(last, html.slice(cursor));
	return root;
}

function attr(rawAttrs: string, name: string): string {
	const found = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(rawAttrs);
	return decodeEntities(found?.[2] ?? found?.[3] ?? found?.[4] ?? "").trim();
}

function addText(node: Node, chunk: string): void {
	const text = normalize(decodeEntities(chunk));
	if (text) node.text = node.text ? `${node.text} ${text}` : text;
}

function decodeEntities(value: string): string {
	return value
		.replace(/&(?:nbsp|#160);/g, " ")
		.replace(/&(?:amp|#38);/g, "&")
		.replace(/&(?:lt|#60);/g, "<")
		.replace(/&(?:gt|#62);/g, ">")
		.replace(/&(?:quot|#34);/g, '"')
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/**
 * Icon fonts render as private-use glyphs that carry no meaning as text, and
 * pages captured out of a JS string arrive with literal `\n` escape sequences.
 */
function normalize(value: string): string {
	return value
		.replace(/[\uE000-\uF8FF]/g, "")
		.replace(/\\[nrt]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function ownText(node: Node): string {
	if (node.cachedText !== undefined) return node.cachedText;
	const parts = node.text ? [node.text] : [];
	for (const child of node.children) {
		const nested = ownText(child);
		if (nested) parts.push(nested);
	}
	node.cachedText = parts.join(" ");
	return node.cachedText;
}

function selectorOf(node: Node): string {
	if (node.id) return `#${node.id}`;
	const stable = node.classes.filter((name) => !/^(odd|even|first|last|active|selected)$/i.test(name));
	return stable.length > 0 ? `${node.tag}.${stable.slice(0, 2).join(".")}` : node.tag;
}

/**
 * Page chrome is judged from the container itself and its immediate parent only.
 * Real sites nest main content arbitrarily deep inside generically named
 * wrappers, so walking every ancestor produces false positives.
 */
function isChrome(node: Node): boolean {
	for (let current: Node | undefined = node; current; current = current.parent) {
		if (CHROME_TAGS.has(current.tag)) return true;
	}
	for (const current of [node, node.parent]) {
		if (!current) continue;
		if (names(current).some((name) => hasWord(name, CHROME_WORDS))) return true;
	}
	return false;
}

function isAncestorOf(ancestor: Node, node: Node): boolean {
	for (let current = node.parent; current; current = current.parent) {
		if (current === ancestor) return true;
	}
	return false;
}

interface Region {
	container: Node;
	containerSelector: string;
	itemSelector: string;
	items: Node[];
	totalText: number;
	averageText: number;
	score: number;
}

function findRegions(root: Node): Region[] {
	const regions: Region[] = [];
	const walk = (node: Node): void => {
		const region = candidate(node);
		if (region) regions.push(region);
		for (const child of node.children) walk(child);
	};
	walk(root);

	// A container whose records themselves contain repeating regions is page
	// layout, not a list. This is what keeps <body>/#wrapper off the podium
	// without hand-tuning text-size thresholds per site.
	for (const region of regions) {
		const wrapsOthers = regions.some(
			(other) => other !== region && isAncestorOf(region.container, other.container),
		);
		if (wrapsOthers) region.score *= 0.08;
	}

	// Near-identical siblings (the same component repeated across page sections)
	// otherwise fill the ranked list with duplicates, pushing real alternatives
	// off the visible top-10 and making the output look like noise.
	const seen = new Set<string>();
	const deduped = regions
		.sort((a, b) => b.score - a.score)
		.filter((region) => {
			const key = `${region.containerSelector}|${region.itemSelector}|${region.items.length}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

	return deduped;
}

/** A region is a container whose children repeat: >= 3 siblings sharing tag + a class token. */
function candidate(node: Node): Region | undefined {
	if (node.children.length < 3) return undefined;

	const groups = new Map<string, Node[]>();
	for (const child of node.children) {
		const tokens = child.classes.length > 0 ? child.classes : [""];
		for (const token of tokens) {
			const key = `${child.tag}|${token}`;
			const group = groups.get(key);
			if (group) {
				if (group[group.length - 1] !== child) group.push(child);
			} else {
				groups.set(key, [child]);
			}
		}
	}

	let best: { key: string; items: Node[]; totalText: number } | undefined;
	for (const [key, items] of groups) {
		if (items.length < 3) continue;
		const totalText = items.reduce((sum, item) => sum + ownText(item).length, 0);
		if (!best || totalText > best.totalText) best = { key, items, totalText };
	}
	if (!best || best.totalText === 0) return undefined;

	const averageText = best.totalText / best.items.length;
	// Menus and tag clouds repeat too, but their records are a couple of words.
	if (averageText < 6) return undefined;

	const token = best.key.split("|")[1] ?? "";
	const first = best.items[0];
	if (!first) return undefined;

	// Real list records are similarly sized; a layout column's children are not.
	const variance =
		best.items.reduce((sum, item) => sum + (ownText(item).length - averageText) ** 2, 0) / best.items.length;
	const uniformity = 1 / (1 + Math.sqrt(variance) / averageText);

	let score = best.items.length * Math.min(averageText, 200) * uniformity;
	if (isChrome(node)) score *= 0.25;
	if (names(node).some((name) => hasWord(name, MAIN_WORDS))) score *= 1.5;

	return {
		container: node,
		containerSelector: selectorOf(node),
		// Records often share no class at all (styled-components emit a class on
		// the container and leave children bare). A naked `div` is useless to the
		// caller — it matches the whole document — so scope it to the container
		// instead. This is the selector the model copies into extract.js, so it
		// has to be one that actually resolves.
		itemSelector: token ? `${first.tag}.${token}` : `${selectorOf(node)} > ${first.tag}`,
		items: best.items,
		totalText: best.totalText,
		averageText,
		score,
	};
}

/** Compact tag/class/text outline of one record, so the model can write field selectors. */
function outline(node: Node, depth: number, budget: { left: number }): string[] {
	if (budget.left <= 0) return [];
	budget.left--;
	const indent = "  ".repeat(depth);
	const classes = node.classes.length > 0 ? `.${node.classes.join(".")}` : "";
	const id = node.id ? `#${node.id}` : "";
	const own = normalize(node.text);
	const label = own ? ` "${own.slice(0, 60)}"` : "";
	const href = node.tag === "a" ? " [href]" : "";
	const lines = [`${indent}${node.tag}${id}${classes}${href}${label}`];
	for (const child of node.children) lines.push(...outline(child, depth + 1, budget));
	return lines;
}

const MAX_OUTPUT = 24_000;

/**
 * Removes markup that can never contain extractable content, once, before any
 * mode runs.
 *
 * Measured on a 488 KB nintendo.com capture: `<svg>` blocks are 56.9% of the
 * file and their `d="M..."` path data alone is 44.7%. Captures arriving here are
 * already script/style-free (the extension strips those), so icon vector data —
 * not JavaScript — is what actually buries the content. Leaving it in costs real
 * probe round-trips: `search` hits land inside path coordinates and `slice`
 * windows open onto bezier curves, and every such miss is another LLM turn.
 *
 * Every mode must share this exact string: node offsets from `parse()` and the
 * raw windows returned by `slice`/`search` are offsets into it. Opening tags are
 * kept so the tree shape and any `id`/`class` survive, keeping the DOM valid for
 * selector authoring; only the inert body is dropped.
 */
function prepare(source: string): { html: string; original: number } {
	// `\x3C!--` is how a comment survives being captured through a JS string.
	let html = source.replace(/(?:<|\\x3C)!--[\s\S]*?-->/g, "");
	for (const tag of ["script", "style", "noscript", "template", "svg"]) {
		html = html.replace(new RegExp(`(<${tag}\\b[^>]*>)[\\s\\S]*?</${tag}\\s*>`, "gi"), `$1</${tag}>`);
	}
	// Icons that are a bare <path>/<use> outside a matched <svg> pair, plus
	// oversized inline data: URIs, which are equally unreadable and equally large.
	html = html.replace(/\sd="[^"]{200,}"/gi, ' d="…"');
	html = html.replace(/(["'(])data:[^"')\s]{200,}/gi, "$1data:…");
	return { html, original: source.length };
}

export interface HtmlProbeOptions {
	/** Reads a file from the client, given a path already resolved against the session cwd. */
	readFile: (path: string) => Promise<string>;
	resolvePath: (path: string) => string;
}

const probeSchema = Type.Object({
	path: Type.String({ description: "Path to the saved HTML file." }),
	mode: Type.Optional(
		Type.Union([Type.Literal("regions"), Type.Literal("outline"), Type.Literal("search"), Type.Literal("slice")], {
			description:
				"Step 1 regions (default): ranked candidate content regions — start here. " +
				"Step 2 outline: tag/class tree of one record, for writing field selectors. " +
				"Then, only to fill a specific gap: search (verify a known string) or slice (raw markup window). " +
				"search/slice are not for locating the content region; regions already did that.",
		}),
	),
	selector: Type.Optional(
		Type.String({ description: "For mode=outline: the itemSelector reported by mode=regions." }),
	),
	query: Type.Optional(Type.String({ description: "For mode=search: substring to locate." })),
	offset: Type.Optional(Type.Number({ description: "For mode=slice: start character offset." })),
	length: Type.Optional(Type.Number({ description: "For mode=slice: window size, capped at 8000." })),
});

export function createHtmlProbeToolDefinition(options: HtmlProbeOptions): ToolDefinition<typeof probeSchema, undefined> {
	return {
		name: "html_probe",
		label: "html_probe",
		description:
			"Analyse a saved HTML page structurally. Use this instead of read/bash for captured pages: they are usually one minified line that read refuses and that shell one-liners cannot inspect portably.\n" +
			"\n" +
			"Follow this funnel in order. Each step narrows the last one; skipping ahead is what makes this slow.\n" +
			"1. mode=regions (start here, always) — ranks the repeating content regions and prints the container/item selector of each. The top-ranked region is almost always the content you want.\n" +
			"2. mode=outline selector=<the itemSelector from step 1> — dumps one record's tag/class tree plus its raw markup. This is where you read off the field selectors for extract.js.\n" +
			"3. mode=slice / mode=search — only for filling a specific gap left by steps 1-2, e.g. confirming a value you could not see in the outline.\n" +
			"\n" +
			"Two steps are usually enough to write the extractor. If you are on your fifth probe and still looking for the content region, stop searching and re-read the step-1 output: the answer is in the ranked list.\n" +
			"Do not use mode=search to hunt for the content region — search is for verifying a known string, not for locating structure. Do not scan with mode=slice at arbitrary offsets.\n" +
			"All offsets refer to the text after script/style/comments are stripped, which mode=regions reports.",
		promptSnippet: "Analyse a saved HTML page's structure",
		parameters: probeSchema,
		async execute(_toolCallId, params) {
			const html = await options.readFile(options.resolvePath(params.path));
			const text = report(html, params);
			return {
				content: [{ type: "text", text: text.slice(0, MAX_OUTPUT) }],
				details: undefined,
			};
		},
	};
}

function report(source: string, params: { mode?: string; selector?: string; query?: string; offset?: number; length?: number }): string {
	const mode = params.mode ?? "regions";
	const { html, original } = prepare(source);

	if (mode === "slice") {
		const start = Math.max(0, params.offset ?? 0);
		const size = Math.min(params.length ?? 4000, 8000);
		return `chars ${start}-${start + size} of ${html.length} (script/style stripped)\n\n${html.slice(start, start + size)}`;
	}

	if (mode === "search") {
		const query = params.query ?? "";
		if (!query) return "mode=search requires `query`.";
		const hits: number[] = [];
		for (let index = html.indexOf(query); index !== -1 && hits.length < 50; index = html.indexOf(query, index + 1)) {
			hits.push(index);
		}
		if (hits.length === 0) {
			return `"${query}" not found (searched the ${html.length} chars remaining after script/style were stripped — it may have been inside one of those). Do not retry with another guess: run mode=regions and read the ranked list instead.`;
		}
		const first = hits[0] ?? 0;
		return [
			`${hits.length}${hits.length === 50 ? "+" : ""} occurrences of "${query}"`,
			`offsets: ${hits.slice(0, 20).join(", ")}`,
			"",
			`--- markup around offset ${first} ---`,
			html.slice(Math.max(0, first - 400), first + 1600),
		].join("\n");
	}

	const root = parse(html);
	const regions = findRegions(root);

	if (mode === "outline") {
		const selector = params.selector?.trim();
		// Accept the container selector too. Models routinely pass whichever of the
		// two they find more meaningful, and a rejection here sends them off on a
		// blind search/slice hunt that costs several turns.
		const region = selector
			? (regions.find((entry) => entry.itemSelector === selector) ??
				regions.find((entry) => entry.containerSelector === selector) ??
				regions.find((entry) => entry.itemSelector.replace(/\s+/g, "") === selector.replace(/\s+/g, "")))
			: regions[0];
		if (!region) {
			// Show what is actually on offer so the next call is guaranteed to hit.
			const available = regions
				.slice(0, 8)
				.map((entry, index) => `  #${index + 1} item=${entry.itemSelector}   (in ${entry.containerSelector}, ${entry.items.length} records)`)
				.join("\n");
			return [
				`No region has itemSelector "${selector}".`,
				"",
				"Available (pass one of these itemSelectors verbatim):",
				available || "  (none — the page has no repeating region)",
			].join("\n");
		}
		const sample = region.items[0];
		if (!sample) return "Region has no records.";
		return [
			`container: ${region.containerSelector}`,
			`item: ${region.itemSelector}  (${region.items.length} records)`,
			"",
			"--- record 1 ---",
			...outline(sample, 0, { left: 120 }),
			"",
			`--- raw markup of record 1 (chars ${sample.start}-${sample.end}) ---`,
			html.slice(sample.start, Math.min(sample.end, sample.start + 3000)),
		].join("\n");
	}

	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
	const lines = [
		`file: ${html.length} chars after stripping script/style/comments (raw capture was ${original})`,
		`All offsets in every html_probe mode refer to this stripped text.`,
		`<title>: ${normalize(decodeEntities(title)) || "(none)"}`,
		"",
		`${regions.length} repeating region(s), ranked. The top one is almost always the main content.`,
		"",
	];

	for (const [index, region] of regions.slice(0, 10).entries()) {
		lines.push(
			`#${index + 1}  score=${Math.round(region.score)}  records=${region.items.length}  avgTextLen=${Math.round(region.averageText)}${isChrome(region.container) ? "  [looks like page chrome]" : ""}`,
			`    container: ${region.containerSelector}`,
			`    item:      ${region.itemSelector}`,
		);
		for (const item of region.items.slice(0, 3)) {
			lines.push(`    - ${ownText(item).slice(0, 90)}`);
		}
		lines.push("");
	}

	lines.push("Next: html_probe mode=outline selector=<item selector> to see one record's field structure.");
	return lines.join("\n");
}
