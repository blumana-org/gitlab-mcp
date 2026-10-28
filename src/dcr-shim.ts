/**
 * Static dynamic-client-registration shim, same design as r2e-mcp.
 *
 * MCP clients (Claude Desktop / claude.ai / Claude Code) register themselves through RFC 7591 when
 * the authorization server advertises a `registration_endpoint`. With Keycloak that creates a client
 * with a random id (or is refused by the Trusted Hosts policy), and GitLab hands out an unverified
 * app: either way the token is then rejected by our strict `azp` / application check.
 *
 * The shim answers the registration itself with the FIXED pre-registered public client id. It
 * registers nothing on the IdP: the redirect URIs must already be allowed on that client. For
 * clients to find it, the server mirrors the IdP's metadata with `registration_endpoint` rewritten,
 * and the protected-resource metadata points to this server as the authorization server.
 * `issuer` and every other endpoint are kept as the IdP's: tokens still come from the IdP.
 */

export interface ShimOptions {
  /** IdP discovery document to mirror. */
  discoveryUrl: string;
  /** The pre-registered public client id every registration answers with. */
  clientId: string;
  /** Absolute URL of this server's registration endpoint. */
  registrationEndpoint: string;
  /** Allowed redirect_uri patterns (exact, trailing `*`, or `:*` = any port). */
  redirectAllowlist: string[];
  timeoutMs?: number;
  /** How long a fetched discovery document is reused. */
  cacheTtlMs?: number;
  now?: () => number;
}

/** Local dev plus the callbacks of the mainstream MCP clients. */
export const DEFAULT_REDIRECT_ALLOWLIST = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

/** The legitimate payload is a handful of redirect URIs. */
const MAX_REGISTER_BODY_BYTES = 16 * 1024;

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
};

export const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

const oauthError = (status: number, error: string, description: string) =>
  Response.json({ error, error_description: description }, { status, headers: CORS_HEADERS });

export function redirectAllowed(allowlist: string[], uri: string): boolean {
  return allowlist.some((entry) => {
    if (entry.endsWith(":*")) {
      // Any port, then nothing or a path.
      const rest = uri.startsWith(`${entry.slice(0, -2)}:`) ? uri.slice(entry.length - 1) : null;
      return rest !== null && /^\d+(\/|$)/.test(rest);
    }
    if (entry.endsWith("*")) return uri.startsWith(entry.slice(0, -1));
    return entry === uri;
  });
}

const addIfMissing = (values: unknown, value: string): string[] => {
  const list = Array.isArray(values) ? (values as string[]) : [];
  return list.includes(value) ? list : [...list, value];
};

export function createDcrShim(opts: ShimOptions) {
  const { timeoutMs = 10_000, cacheTtlMs = 3_600_000, now = Date.now } = opts;
  let cached: { doc: Record<string, unknown>; until: number } | undefined;

  async function discover(): Promise<Record<string, unknown>> {
    if (cached && cached.until > now()) return cached.doc;
    const res = await fetch(opts.discoveryUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${opts.discoveryUrl}`);
    const doc = (await res.json()) as Record<string, unknown>;
    cached = { doc, until: now() + cacheTtlMs };
    return doc;
  }

  /** The IdP's metadata, pointing registration to us and advertising what a public PKCE client needs. */
  async function metadata(): Promise<Response> {
    let raw: Record<string, unknown>;
    try {
      raw = await discover();
    } catch (err) {
      console.error(`[auth] cannot mirror authorization server metadata: ${err instanceof Error ? err.message : err}`);
      return oauthError(503, "temporarily_unavailable", "authorization server metadata is currently unavailable");
    }
    const doc = {
      ...raw,
      registration_endpoint: opts.registrationEndpoint,
      code_challenge_methods_supported: addIfMissing(raw.code_challenge_methods_supported, "S256"),
      token_endpoint_auth_methods_supported: addIfMissing(raw.token_endpoint_auth_methods_supported, "none"),
    };
    return Response.json(doc, { headers: { ...CORS_HEADERS, "cache-control": "public, max-age=300" } });
  }

  /** RFC 7591 answer with the fixed client id; only allowlisted redirect URIs are echoed back. */
  async function register(req: Request): Promise<Response> {
    const text = await req.text();
    if (text.length > MAX_REGISTER_BODY_BYTES) {
      return oauthError(413, "invalid_client_metadata", "registration request body too large");
    }
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = JSON.parse(text);
      if (typeof body !== "object" || body === null) throw new Error();
    } catch {
      return oauthError(400, "invalid_client_metadata", "registration request is not a JSON object");
    }
    const requested = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    const accepted = requested.filter((uri) => redirectAllowed(opts.redirectAllowlist, uri));
    if (accepted.length === 0) {
      console.error(`[auth] registration refused: no allowed redirect_uri in ${JSON.stringify(requested)} (MCP_REDIRECT_URIS)`);
      return oauthError(400, "invalid_redirect_uri", "no requested redirect_uri is allowed (MCP_REDIRECT_URIS)");
    }
    const client = typeof body.client_name === "string" ? body.client_name : "unnamed client";
    console.error(`[auth] registration from "${client}" -> client_id ${opts.clientId} (redirect ${accepted.join(", ")})`);
    return Response.json(
      {
        client_id: opts.clientId,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: accepted,
        ...(typeof body.client_name === "string" ? { client_name: body.client_name } : {}),
      },
      { status: 201, headers: CORS_HEADERS },
    );
  }

  return { metadata, register };
}
