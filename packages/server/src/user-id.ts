/**
 * Identity resolution.
 *
 * PROTOTYPE MODE: the caller-supplied `X-User-Id` header is trusted verbatim.
 * That means any client can impersonate any user and read their sessions.
 * Before this leaves a trusted network, replace `resolveUserId` with a check
 * that derives the id from a verified credential (signed JWT, Cloudflare Access
 * `Cf-Access-Jwt-Assertion`, or a server-issued session token). The rest of the
 * system already treats the returned value as authoritative, so this is the
 * only function that needs to change.
 */

export const USER_ID_HEADER = "X-User-Id";

/** Conservative charset: also keeps the value safe as a Durable Object name. */
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export function resolveUserId(request: Request): string | null {
	const raw = request.headers.get(USER_ID_HEADER)?.trim();
	if (!raw || !USER_ID_PATTERN.test(raw)) return null;
	return raw;
}
