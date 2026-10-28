import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { AuthUnavailableError, list, type AuthProvider, type TokenVerifier } from "./auth.ts";

/**
 * GitLab as the authorization server: users log in with their GitLab account, and tools call
 * GitLab with their own token, so they only see what their GitLab permissions allow.
 */
export interface GitLabOAuthConfig {
  /** GitLab base URL used by this server (token checks), possibly an internal address. */
  url: string;
  /** Issuer advertised to MCP clients: GitLab's public URL, exactly as in its OIDC discovery document. */
  issuer: string;
  /** Application ID of the GitLab OAuth application MCP clients log in with. */
  clientId: string;
  /** Scopes advertised to clients; a token must carry all of them. */
  scopes: string[];
  timeoutMs: number;
  /** How long a validated token is trusted before asking GitLab again. */
  cacheTtlMs: number;
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export function gitlabOAuthConfigFromEnv(env = process.env): GitLabOAuthConfig | null {
  if (!env.GITLAB_OAUTH_CLIENT_ID) return null;
  const url = trimSlash(env.GITLAB_URL ?? "https://gitlab.com");
  return {
    url,
    issuer: env.GITLAB_OAUTH_ISSUER || url,
    clientId: env.GITLAB_OAUTH_CLIENT_ID,
    scopes: list(env.GITLAB_OAUTH_SCOPES ?? "read_api"),
    timeoutMs: Number(env.GITLAB_TIMEOUT_MS ?? 20_000),
    cacheTtlMs: 60_000,
  };
}

/** Doorkeeper's GET /oauth/token/info response. */
interface TokenInfo {
  resource_owner_id?: number;
  scope?: string[] | string;
  expires_in?: number | null;
  application?: { uid?: string } | null;
}

const MAX_CACHE_ENTRIES = 10_000;

/**
 * GitLab access tokens are opaque: ask GitLab who issued them. Checking the application is what
 * makes forwarding the token legitimate: a PAT, or a token of another GitLab app, is refused.
 */
export function createGitLabTokenVerifier(config: GitLabOAuthConfig, now = Date.now): TokenVerifier {
  // Keyed by token hash. Revocation is still enforced by GitLab on every API call made with the token.
  const cache = new Map<string, { info: AuthInfo; until: number }>();

  return async (token) => {
    const key = new Bun.CryptoHasher("sha256").update(token).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.info;
    cache.delete(key);

    const info = await introspect(config, token, now());
    const expiresAtMs = info.expiresAt ? info.expiresAt * 1000 : Infinity;
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { info, until: Math.min(now() + config.cacheTtlMs, expiresAtMs) });
    return info;
  };
}

async function introspect(config: GitLabOAuthConfig, token: string, nowMs: number): Promise<AuthInfo> {
  let res: Response;
  try {
    res = await fetch(`${config.url}/oauth/token/info`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    throw new AuthUnavailableError(`GitLab unreachable at ${config.url} for token check: ${err instanceof Error ? err.message : err}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("GitLab does not recognise this token (expired, revoked, or not an OAuth access token)");
  }
  if (!res.ok) throw new AuthUnavailableError(`GitLab token check failed: HTTP ${res.status}`);

  const body = (await res.json()) as TokenInfo;
  const uid = body.application?.uid;
  if (uid !== config.clientId) {
    // Typical cause: the MCP client used dynamic client registration instead of the pre-registered app.
    throw new Error(
      `Token was not issued to GitLab application ${config.clientId} (issued to: ${uid ?? "no application"}; ` +
        `configure the MCP client with --client-id ${config.clientId})`,
    );
  }
  const scopes = Array.isArray(body.scope) ? body.scope : list(body.scope);
  const missing = config.scopes.filter((s) => !scopes.includes(s));
  if (missing.length) throw new Error(`Token lacks scope(s): ${missing.join(", ")} (has: ${scopes.join(", ")})`);

  return {
    token,
    clientId: uid,
    scopes,
    expiresAt: body.expires_in == null ? undefined : Math.floor(nowMs / 1000) + body.expires_in,
    extra: { sub: body.resource_owner_id === undefined ? undefined : String(body.resource_owner_id) },
  };
}

export function describeGitLabToken(token: string): Record<string, unknown> {
  if (token.startsWith("glpat-")) return { format: "GitLab personal access token (only OAuth tokens are accepted)" };
  return { format: token.split(".").length === 3 ? "JWT (not a GitLab OAuth access token?)" : "opaque", length: token.length };
}

export function gitlabOAuthProvider(config: GitLabOAuthConfig): AuthProvider {
  return {
    kind: "gitlab",
    issuer: config.issuer,
    discoveryUrl: `${config.url}/.well-known/openid-configuration`,
    publicClientId: config.clientId,
    scopes: config.scopes,
    verify: createGitLabTokenVerifier(config),
    expected: { application: config.clientId, scopes: config.scopes },
    describe: describeGitLabToken,
  };
}

/**
 * Boot check: GitLab is reachable and its discovery `issuer` is the one we advertise
 * (MCP clients refuse an authorization server whose metadata names another issuer).
 */
export async function checkGitLabOAuth(config: GitLabOAuthConfig): Promise<string> {
  const res = await fetch(`${config.url}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(config.timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${config.url}/.well-known/openid-configuration`);
  const { issuer } = (await res.json()) as { issuer?: string };
  if (issuer !== config.issuer) {
    throw new Error(`GitLab advertises issuer "${issuer}" but clients are sent to "${config.issuer}" (set GITLAB_OAUTH_ISSUER="${issuer}")`);
  }
  return `issuer ${issuer}, application ${config.clientId}, scopes ${config.scopes.join(" ")}`;
}
