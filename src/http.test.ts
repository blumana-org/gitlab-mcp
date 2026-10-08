import { afterAll, beforeAll, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createTokenVerifier, oidcConfigFromEnv, oidcProvider, type OidcConfig } from "./auth.ts";
import { GitLabClient } from "./gitlab.ts";
import { startHttpServer } from "./http.ts";

let idp: ReturnType<typeof Bun.serve>;
let mcp: ReturnType<typeof startHttpServer>;
let privateKey: CryptoKey;
let issuer: string;

const CLIENT_ID = "gitlab-mcp-public";

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256" };

  idp = Bun.serve({
    port: 0,
    routes: {
      "/.well-known/openid-configuration": () => Response.json({ issuer, jwks_uri: `${issuer}/jwks` }),
      "/jwks": Response.json({ keys: [jwk] }),
    },
  });
  issuer = idp.url.origin;

  const config: OidcConfig = { issuer, clientId: CLIENT_ID, scopes: ["openid", "email"] };
  mcp = startHttpServer({
    port: 0,
    publicUrl: "https://mcp.example.com",
    gitlab: new GitLabClient("https://gitlab.invalid", "t"),
    auth: oidcProvider(config),
  });
});

afterAll(() => {
  mcp.stop(true);
  idp.stop(true);
});

const sign = (claims: Record<string, unknown>, iss = issuer) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(iss)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

const listTools = (token?: string) =>
  fetch(new URL("/mcp", mcp.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

test("serves protected resource metadata", async () => {
  const res = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", mcp.url));
  expect(await res.json()).toMatchObject({
    resource: "https://mcp.example.com/mcp",
    authorization_servers: [issuer],
  });
});

test("rejects requests without token, pointing to metadata", async () => {
  const res = await listTools();
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toContain(
    'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
  );
});

test("rejects tokens from another client or issuer", async () => {
  expect((await listTools(await sign({ azp: "other-app" }))).status).toBe(401);
  expect((await listTools(await sign({ azp: CLIENT_ID }, "https://evil.example.com"))).status).toBe(401);
  expect((await listTools("not-a-jwt")).status).toBe(401);
});

test("accepts a valid token and serves MCP", async () => {
  const res = await listTools(await sign({ azp: CLIENT_ID }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.result.tools.map((t: any) => t.name)).toContain("get_job");
});

test("401 explains why a token was rejected", async () => {
  const res = await listTools(await sign({ azp: "other-app" }));
  expect(res.headers.get("www-authenticate")).toContain("Token was not issued to client gitlab-mcp-public");
});

test("issuer with trailing slash validates and discovers JWKS", async () => {
  const config: OidcConfig = { issuer: `${issuer}/`, clientId: CLIENT_ID, scopes: [] };
  const info = await createTokenVerifier(config)(await sign({ azp: CLIENT_ID }, `${issuer}/`));
  expect(info.clientId).toBe(CLIENT_ID);
});

test("oidcConfigFromEnv requires audience or client id", () => {
  expect(oidcConfigFromEnv({})).toBeNull();
  expect(() => oidcConfigFromEnv({ OIDC_ISSUER: "https://idp" })).toThrow();
  // Issuer is kept verbatim: some IdPs (Auth0) put a trailing slash in `iss`.
  expect(oidcConfigFromEnv({ OIDC_ISSUER: "https://idp/", OIDC_CLIENT_ID: "c" })).toMatchObject({
    issuer: "https://idp/",
    scopes: ["openid", "profile", "email"],
  });
});
