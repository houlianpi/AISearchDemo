// Must stay first: it disables TypeBox JIT before pi's modules are evaluated.
import "./typebox-setup.ts";
import type { Env } from "./env.ts";
import { resolveUserId, USER_ID_HEADER } from "./user-id.ts";

export { UserAgentDO } from "./do/user-agent-do.ts";

/**
 * Stateless front door. Validates the upgrade request here (not in the Durable
 * Object) so malformed traffic never bills against a DO, then routes to the
 * one Durable Object that owns this user's sessions.
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({ ok: true });
		}

		if (url.pathname !== "/ws") {
			return new Response("not found", { status: 404 });
		}

		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("expected Upgrade: websocket", { status: 426 });
		}

		const userId = resolveUserId(request);
		if (!userId) {
			return new Response(`missing or malformed ${USER_ID_HEADER}`, { status: 401 });
		}

		const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
		// Forward the resolved identity out-of-band; the DO must never re-parse
		// the raw client header. Rewriting the URL avoids mutating headers on an
		// upgrade request.
		const forwardedUrl = new URL(url);
		forwardedUrl.searchParams.set("uid", userId);
		return stub.fetch(new Request(forwardedUrl, request));
	},
} satisfies ExportedHandler<Env>;
