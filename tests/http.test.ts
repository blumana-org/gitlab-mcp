import { afterAll, beforeAll, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createTokenVerifier, oidcConfigFromEnv, oidcProvider, type OidcConfig } from "../src/auth.ts";
import { GitLabClient } from "../src/gitlab.ts";
import { redirectAllowed } from "../src/dcr-shim.ts";
import { startHttpServer } from "../src/http.ts";
import { VictoriaLogsClient } from "../src/victorialogs.ts";
import { VictoriaMetricsClient } from "../src/victoriametrics.ts";

let idp: ReturnType<typeof Bun.serve>;
/** Fake GitLab + VictoriaLogs/VictoriaMetrics (behind oauth2-proxy): record which credentials each one receives. */
let upstream: ReturnType<typeof Bun.serve>;
const received = { gitlab: [] as Record<string, string | null>[], victorialogs: [] as (string | null)[], victoriametrics: [] as (string | null)[] };
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

  upstream = Bun.serve({
    port: 0,
    fetch: (req) => {
      const { pathname } = new URL(req.url);
      if (pathname.startsWith("/logs/")) {
        received.victorialogs.push(req.headers.get("authorization"));
        return new Response('{"_time":"t","_msg":"boom"}\n');
      }
      if (pathname.startsWith("/metrics/")) {
        received.victoriametrics.push(req.headers.get("authorization"));
        return Response.json({ status: "success", data: { resultType: "vector", result: [] } });
      }
      received.gitlab.push({ token: req.headers.get("private-token"), authorization: req.headers.get("authorization") });
      return Response.json({ id: 1, status: "failed" });
    },
  });

  const config: OidcConfig = { issuer, clientId: CLIENT_ID, scopes: ["openid", "email"] };
  mcp = startHttpServer({
    port: 0,
    publicUrl: "https://mcp.example.com",
    gitlab: new GitLabClient(upstream.url.origin, "server-pat"),
    victoria: {
      logs: new VictoriaLogsClient(`${upstream.url.origin}/logs`, "ignored-static-token"),
      metrics: new VictoriaMetricsClient(`${upstream.url.origin}/metrics`, "ignored-static-token"),
    },
    auth: oidcProvider(config),
  });
});

afterAll(() => {
  mcp.stop(true);
  idp.stop(true);
  upstream.stop(true);
});

const sign = (claims: Record<string, unknown>, iss = issuer) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(iss)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

const rpc = (method: string, params: unknown, token?: string) =>
  fetch(new URL("/mcp", mcp.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
const listTools = (token?: string) => rpc("tools/list", {}, token);

test("serves protected resource metadata, pointing to the DCR shim", async () => {
  const res = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", mcp.url));
  expect(await res.json()).toMatchObject({
    resource: "https://mcp.example.com/mcp",
    authorization_servers: ["https://mcp.example.com"],
  });
});

test("DCR shim: mirrors the IdP metadata with our registration endpoint", async () => {
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    const body = (await (await fetch(new URL(path, mcp.url))).json()) as any;
    // issuer and endpoints stay the IdP's: tokens are still minted and checked there.
    expect(body).toMatchObject({
      issuer,
      jwks_uri: `${issuer}/jwks`,
      registration_endpoint: "https://mcp.example.com/oauth/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }
});

const register = (body: unknown) =>
  fetch(new URL("/oauth/register", mcp.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("DCR shim: every registration gets the pre-registered client id", async () => {
  const res = await register({
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example.com/cb"],
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({
    client_id: CLIENT_ID,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    client_name: "Claude",
  });
  expect((await register({ redirect_uris: ["http://localhost:33418/callback"] })).status).toBe(201);
});

test("DCR shim: refuses unknown redirect URIs and malformed requests", async () => {
  const res = await register({ redirect_uris: ["https://evil.example.com/cb"] });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
  expect((await register("not json")).status).toBe(400);
  expect((await register("x".repeat(20_000))).status).toBe(413);
});

test("DCR shim can be disabled: clients are sent to the IdP directly", async () => {
  const plain = startHttpServer({
    port: 0,
    publicUrl: "https://mcp.example.com",
    gitlab: new GitLabClient(upstream.url.origin, "server-pat"),
    auth: oidcProvider({ issuer, clientId: CLIENT_ID, scopes: [] }),
    dcrShim: false,
  });
  try {
    const prm = (await (await fetch(new URL("/.well-known/oauth-protected-resource/mcp", plain.url))).json()) as any;
    expect(prm.authorization_servers).toEqual([issuer]);
    expect((await fetch(new URL("/oauth/register", plain.url), { method: "POST", body: "{}" })).status).toBe(404);
  } finally {
    plain.stop(true);
  }
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

test("OIDC: the user's token goes to Victoria* only, GitLab keeps the server PAT", async () => {
  const token = await sign({ azp: CLIENT_ID });
  const logs = (await (await rpc("tools/call", { name: "query_logs", arguments: { query: "error" } }, token)).json()) as any;
  expect(logs.result.isError).toBeFalsy();
  expect(received.victorialogs.at(-1)).toBe(`Bearer ${token}`);

  const metrics = (await (await rpc("tools/call", { name: "query_metrics", arguments: { query: "up" } }, token)).json()) as any;
  expect(metrics.result.isError).toBeFalsy();
  expect(received.victoriametrics.at(-1)).toBe(`Bearer ${token}`);

  const pipeline = (await (await rpc("tools/call", { name: "get_pipeline", arguments: { project: 1, pipeline_id: 2 } }, token)).json()) as any;
  expect(pipeline.result.isError).toBeFalsy();
  expect(received.gitlab.at(-1)).toEqual({ token: "server-pat", authorization: null });
});

test("redirect allowlist patterns", () => {
  const allow = ["http://localhost:*", "https://claude.ai/api/mcp/auth_callback", "https://inspector.example/*"];
  expect(redirectAllowed(allow, "http://localhost:8765/callback")).toBe(true);
  expect(redirectAllowed(allow, "http://localhost:8765")).toBe(true);
  expect(redirectAllowed(allow, "http://localhost.evil.com/cb")).toBe(false);
  expect(redirectAllowed(allow, "http://localhost:80evil/cb")).toBe(false);
  expect(redirectAllowed(allow, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
  expect(redirectAllowed(allow, "https://claude.ai/api/mcp/auth_callback/x")).toBe(false);
  expect(redirectAllowed(allow, "https://inspector.example/oauth")).toBe(true);
});
