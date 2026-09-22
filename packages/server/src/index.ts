import "./typebox-setup.ts";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentService } from "./local/agent-service.ts";
import { createHttpHandler } from "./local/http.ts";

try { process.loadEnvFile(); } catch {}

export function startServer(port = Number.parseInt(process.env.PORT ?? "8787", 10)) {
	const service = new AgentService();
	const server = createServer(createHttpHandler(service));
	server.listen(port, "127.0.0.1", () => {
		console.log(`image AI search server listening on http://127.0.0.1:${port}`);
	});
	return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	startServer();
}
