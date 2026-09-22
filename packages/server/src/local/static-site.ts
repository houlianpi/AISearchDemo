import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../../public");
const assets = new Map([
	["/", { file: "index.html", type: "text/html; charset=utf-8" }],
	["/assets/app.css", { file: "app.css", type: "text/css; charset=utf-8" }],
	["/assets/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
	["/assets/client-logic.js", { file: "client-logic.js", type: "text/javascript; charset=utf-8" }],
]);

export async function staticAsset(path: string): Promise<{ body: Buffer; contentType: string } | undefined> {
	const asset = assets.get(path);
	if (!asset) return undefined;
	return { body: await readFile(join(publicDir, asset.file)), contentType: asset.type };
}
