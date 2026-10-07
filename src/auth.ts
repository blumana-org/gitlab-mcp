import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface OidcConfig {
  issuer: string;
  /** Expected `aud` claim. At least one of audience / clientId must be set. */
  audience?: string;
  /** Expected `azp` / `client_id` claim: the public client registered in the IdP. */
  clientId?: string;
  /** Scopes advertised to MCP clients (they request these from the IdP). */
  scopes: string[];
  jwksUri?: string;
}

const list = (v: string | undefined) => v?.split(/[\s,]+/).filter(Boolean) ?? [];

export function oidcConfigFromEnv(env = process.env): OidcConfig | null {
  if (!env.OIDC_ISSUER) return null;
  const config: OidcConfig = {
    issuer: env.OIDC_ISSUER.replace(/\/+$/, ""),
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
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
  const { jwks_uri } = (await res.json()) as { jwks_uri?: string };
  if (!jwks_uri) throw new Error(`No jwks_uri in OIDC discovery document of ${issuer}`);
  return jwks_uri;
}

export type TokenVerifier = (token: string) => Promise<AuthInfo>;

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

/** RFC 9728 Protected Resource Metadata: tells MCP clients which IdP to log in with. */
export function protectedResourceMetadata(config: OidcConfig, resource: string) {
  return {
    resource,
    authorization_servers: [config.issuer],
    scopes_supported: config.scopes,
    bearer_methods_supported: ["header"],
    resource_name: "GitLab MCP",
  };
}
