import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const extensionPath = join(dirname(require.resolve("pi-web-access/package.json")), "index.ts");
const loader = new DefaultResourceLoader({
	cwd: process.cwd(), agentDir: process.cwd(), settingsManager: SettingsManager.inMemory(),
	additionalExtensionPaths: [extensionPath],
	noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
assert.ok(loaded.extensions.some((extension) => extension.tools.has("web_search")));
console.log("pi-web-access SDK load: web_search available");
