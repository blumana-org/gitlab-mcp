import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";

export interface OidcConfig {
  /** Exact `iss` value of the IdP's tokens (trailing slash matters, e.g. Auth0). */
  issuer: string;
  /** Expected `aud` claim. At least one of audience / clientId must be set. */
  audience?: string;
  /** Expected `azp` / `client_id` claim: the public client registered in the IdP. */
  clientId?: string;
  /** Scopes advertised to MCP clients (they request these from the IdP). */
  scopes: string[];
  jwksUri?: string;
}

export const list = (v: string | undefined) => v?.split(/[\s,]+/).filter(Boolean) ?? [];

export type TokenVerifier = (token: string) => Promise<AuthInfo>;

/** How /mcp bearer tokens are validated, and which authorization server MCP clients log in with. */
export interface AuthProvider {
  /** `gitlab`: tokens are GitLab OAuth tokens, and GitLab is called with the caller's own token. */
  kind: "oidc" | "gitlab";
  /** The real authorization server (the `iss` of its tokens). */
  issuer: string;
  /** Its discovery document, mirrored by the DCR shim. */
  discoveryUrl: string;
  /** Pre-registered public client the DCR shim hands out; undefined = no shim possible. */
  publicClientId?: string;
  /** Scopes advertised to MCP clients (they request these from the authorization server). */
  scopes: string[];
  verify: TokenVerifier;
  /** What a valid token must carry, logged next to a rejected token's details. */
  expected: Record<string, unknown>;
  /** Unverified details of a rejected token, for logs (never the token itself). */
  describe: (token: string) => Record<string, unknown>;
}

/** The authorization server could not be reached: answer 503, not 401 (the client must not re-login). */
export class AuthUnavailableError extends Error {}

export function oidcConfigFromEnv(env = process.env): OidcConfig | null {
  if (!env.OIDC_ISSUER) return null;
  const config: OidcConfig = {
    issuer: env.OIDC_ISSUER,
    audience: env.OIDC_AUDIENCE || undefined,
    clientId: env.OIDC_CLIENT_ID || undefined,
    scopes: list(env.OIDC_SCOPES ?? "openid profile email"),
    jwksUri: env.OIDC_JWKS_URI || undefined,
  };
  // Without one of these, any token minted by the IdP for any app would be accepted.
  if (!config.audience && !config.clientId) {
    throw new Error("OIDC_AUDIENCE or OIDC_CLIENT_ID is required when OIDC_ISSUER is set");
  }
  return config;
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const res = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
  const { jwks_uri } = (await res.json()) as { jwks_uri?: string };
  if (!jwks_uri) throw new Error(`No jwks_uri in OIDC discovery document of ${issuer}`);
  return jwks_uri;
}

export function createTokenVerifier(config: OidcConfig): TokenVerifier {
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  const getJwks = async () =>
    (jwks ??= createRemoteJWKSet(new URL(config.jwksUri ?? (await discoverJwksUri(config.issuer)))));

  return async (token) => {
    const { payload } = await jwtVerify(token, await getJwks(), {
      issuer: config.issuer,
      audience: config.audience,
    });
    const clientId = (payload.azp ?? payload.client_id ?? payload.cid) as string | undefined;
    if (config.clientId && clientId !== config.clientId) {
      throw new Error(`Token was not issued to client ${config.clientId}`);
    }
    return {
      token,
      clientId: clientId ?? "",
      scopes: scopesOf(payload),
      expiresAt: payload.exp,
      extra: { sub: payload.sub, email: payload.email, name: payload.name },
    };
  };
}

function scopesOf(payload: JWTPayload): string[] {
  if (typeof payload.scope === "string") return list(payload.scope);
  if (Array.isArray(payload.scp)) return payload.scp as string[];
  return [];
}

export function oidcProvider(config: OidcConfig): AuthProvider {
  return {
    kind: "oidc",
    issuer: config.issuer,
    discoveryUrl: `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    publicClientId: config.clientId,
    scopes: config.scopes,
    verify: createTokenVerifier(config),
    expected: { iss: config.issuer, aud: config.audience, azp: config.clientId },
    describe: describeToken,
  };
}

/**
 * RFC 9728 Protected Resource Metadata: tells MCP clients which authorization server to log in with.
 * With the DCR shim it is this server, so clients read the mirrored metadata and its registration endpoint.
 */
export function protectedResourceMetadata(auth: Pick<AuthProvider, "issuer" | "scopes">, resource: string, authorizationServer = auth.issuer) {
  return {
    resource,
    authorization_servers: [authorizationServer],
    scopes_supported: auth.scopes,
    bearer_methods_supported: ["header"],
    resource_name: "DevOps MCP",
  };
}

/** Unverified claims useful to diagnose a rejected token (never log the token itself). */
export function describeToken(token: string): Record<string, unknown> {
  try {
    const { iss, aud, azp, client_id, exp, sub, scope, scp } = decodeJwt(token);
    return { iss, aud, azp, client_id, sub, scope: scope ?? scp, exp: exp && new Date(exp * 1000).toISOString() };
  } catch {
    return { format: token.split(".").length === 3 ? "malformed JWT" : "not a JWT (opaque token?)" };
  }
}
