#!/usr/bin/env bun
/**
 * Replays the MCP OAuth flow step by step (like Claude Code does) to find where it breaks.
 *
 *   bun run doctor https://gitlab-mcp.example.com/mcp                       # discovery checks only
 *   bun run doctor https://gitlab-mcp.example.com/mcp --client-id gitlab-mcp --callback-port 8765   # + real login
 */
import { parseArgs } from "node:util";
import { describeToken } from "./auth.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    "client-id": { type: "string" },
    "callback-port": { type: "string", default: "8765" },
    scope: { type: "string" },
    "no-resource": { type: "boolean", default: false },
  },
});

const mcpUrl = positionals[0];
if (!mcpUrl) {
  console.error("usage: bun run doctor <mcp-url> [--client-id <id>] [--callback-port 8765] [--scope '...'] [--no-resource]");
  process.exit(2);
}

const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg: string) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);
const fail = (msg: string): never => {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
};
const step = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m`);

async function getJson(url: string): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(url);
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text.slice(0, 200) };
    }
  } catch (err) {
    return fail(`${url} unreachable: ${err instanceof Error ? err.message : err}`);
  }
}

const mcpPost = (body: unknown, token?: string) =>
  fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gitlab-mcp-doctor", version: "0" } },
};

// 1. Unauthenticated call must be challenged with a pointer to the resource metadata.
step(`1. Unauthenticated call to ${mcpUrl}`);
const challenge = await mcpPost(initialize);
const wwwAuth = challenge.headers.get("www-authenticate") ?? "";
if (challenge.status !== 401) fail(`expected 401, got ${challenge.status} (auth disabled, or wrong URL / proxy?)`);
ok("401 returned");
const metadataUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
if (!metadataUrl) fail(`no resource_metadata in WWW-Authenticate: "${wwwAuth}" (a proxy may strip this header)`);
ok(`WWW-Authenticate -> ${metadataUrl}`);

// 2. Protected resource metadata (RFC 9728).
step("2. Protected resource metadata");
const prm = await getJson(metadataUrl!);
if (prm.status !== 200) fail(`HTTP ${prm.status} on ${metadataUrl}`);
if (prm.body.resource !== mcpUrl) {
  warn(`resource is "${prm.body.resource}" but you connect to "${mcpUrl}" -> check MCP_PUBLIC_URL`);
} else ok(`resource = ${prm.body.resource}`);
const issuer: string | undefined = prm.body.authorization_servers?.[0];
if (!issuer) fail("no authorization_servers");
ok(`authorization server = ${issuer}`);
const scopes: string = values.scope ?? (prm.body.scopes_supported ?? []).join(" ");
ok(`scopes advertised = "${scopes}"`);

// 3. Authorization server metadata, tried in the order MCP clients use.
step("3. Authorization server metadata");
const iss = new URL(issuer!);
const path = iss.pathname.replace(/\/+$/, "");
const candidates =
  path === ""
    ? [`${iss.origin}/.well-known/oauth-authorization-server`, `${iss.origin}/.well-known/openid-configuration`]
    : [
        `${iss.origin}/.well-known/oauth-authorization-server${path}`,
        `${iss.origin}/.well-known/openid-configuration${path}`,
        `${iss.origin}${path}/.well-known/openid-configuration`,
      ];
let as: any;
for (const url of candidates) {
  const res = await getJson(url);
  if (res.status === 200 && typeof res.body === "object") {
    ok(`found at ${url}`);
    as = res.body;
    break;
  }
  console.log(`  · ${url} -> HTTP ${res.status}`);
}
if (!as) fail("no metadata found: the IdP must expose OAuth or OIDC discovery for this issuer");
if (as.issuer !== issuer) warn(`metadata issuer "${as.issuer}" != "${issuer}" -> OIDC_ISSUER must match it exactly`);
else ok("issuer matches");
for (const k of ["authorization_endpoint", "token_endpoint"]) {
  if (!as[k]) fail(`missing ${k}`);
}
ok(`authorization_endpoint = ${as.authorization_endpoint}`);
ok(`token_endpoint = ${as.token_endpoint}`);
const methods: string[] = as.code_challenge_methods_supported ?? [];
if (!methods.includes("S256")) {
  warn(`code_challenge_methods_supported = ${JSON.stringify(methods)}: MCP clients refuse an IdP that does not advertise S256 (PKCE)`);
} else ok("PKCE S256 supported");
if (!values["client-id"]) {
  if (as.registration_endpoint) ok(`dynamic client registration available (${as.registration_endpoint})`);
  else warn("no registration_endpoint: Claude Code needs --client-id (pre-registered public client)");
  step("Done (pass --client-id to also test a real login)");
  process.exit(0);
}

// 4. Real authorization code + PKCE login, with the same redirect URI as Claude Code.
step("4. Login (authorization code + PKCE)");
const clientId = values["client-id"]!;
const port = Number(values["callback-port"]);
const redirectUri = `http://localhost:${port}/callback`;
const b64url = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf as ArrayBuffer).toString("base64url");
const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challengeS256 = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
const state = b64url(crypto.getRandomValues(new Uint8Array(16)));

const authUrl = new URL(as.authorization_endpoint);
authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  code_challenge: challengeS256,
  code_challenge_method: "S256",
  state,
  ...(scopes ? { scope: scopes } : {}),
  // RFC 8707: MCP clients send the resource. Some IdPs (Entra ID v2) reject it -> retry with --no-resource.
  ...(values["no-resource"] ? {} : { resource: prm.body.resource }),
}).toString();

const code = await new Promise<string>((resolve) => {
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      const p = url.searchParams;
      setTimeout(() => server.stop(), 100);
      if (p.get("error")) {
        fail(`IdP returned error=${p.get("error")}: ${p.get("error_description") ?? ""}`);
      }
      if (p.get("state") !== state) fail("state mismatch");
      resolve(p.get("code")!);
      return new Response("gitlab-mcp doctor: you can close this tab.");
    },
  });
  console.log(`  · listening on ${redirectUri} (must be an allowed redirect URI of client "${clientId}")`);
  console.log(`  · opening browser: ${authUrl}`);
  Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", authUrl.toString()], { stdout: "ignore", stderr: "ignore" });
});
ok("authorization code received");

// 5. Token exchange (public client: no secret).
step("5. Token exchange");
const tokenRes = await fetch(as.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    ...(values["no-resource"] ? {} : { resource: prm.body.resource }),
  }),
});
const tokens: any = await tokenRes.json().catch(() => ({}));
if (!tokenRes.ok || !tokens.access_token) {
  fail(`HTTP ${tokenRes.status}: ${JSON.stringify(tokens)} (client must be public, without secret)`);
}
ok(`access_token received (token_type=${tokens.token_type}, scope=${tokens.scope ?? "?"})`);
console.log("  · claims:", JSON.stringify(describeToken(tokens.access_token)));

// 6. Authenticated MCP call.
step("6. Authenticated MCP call");
const authed = await mcpPost(initialize, tokens.access_token);
if (authed.status !== 200) {
  fail(`HTTP ${authed.status}: ${authed.headers.get("www-authenticate") ?? (await authed.text()).slice(0, 300)}`);
}
ok("initialize accepted");
const list = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, tokens.access_token);
const tools = ((await list.json()) as any).result?.tools?.map((t: any) => t.name) ?? [];
ok(`tools: ${tools.join(", ")}`);
step("All good: the server side works, if Claude Code still fails, compare with its debug logs.");
