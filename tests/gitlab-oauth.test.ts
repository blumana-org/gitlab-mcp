import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GitLabClient } from "../src/gitlab.ts";
import {
  checkGitLabOAuth,
  createGitLabTokenVerifier,
  gitlabOAuthConfigFromEnv,
  gitlabOAuthProvider,
  type GitLabOAuthConfig,
} from "../src/gitlab-oauth.ts";
import { startHttpServer } from "../src/http.ts";

const APP_ID = "mcp-app-uid";

/** token -> what GET /oauth/token/info answers for it */
const tokens: Record<string, { status?: number; body?: unknown }> = {
  "user-token": { body: { resource_owner_id: 7, scope: ["read_api"], expires_in: 7200, application: { uid: APP_ID } } },
  "other-app": { body: { resource_owner_id: 7, scope: ["read_api"], expires_in: 7200, application: { uid: "someone-else" } } },
  "no-scope": { body: { resource_owner_id: 7, scope: ["read_user"], expires_in: 7200, application: { uid: APP_ID } } },
  "glpat-abc": { status: 401, body: { error: "invalid_token" } },
};

let gitlab: ReturnType<typeof Bun.serve>;
let mcp: ReturnType<typeof startHttpServer>;
let config: GitLabOAuthConfig;
let tokenInfoCalls = 0;
let apiAuth: (string | null)[] = [];
let tokenInfoDown = false;

beforeAll(() => {
  gitlab = Bun.serve({
    port: 0,
    routes: {
      "/.well-known/openid-configuration": () => Response.json({ issuer: gitlab.url.origin }),
      "/oauth/token/info": (req) => {
        tokenInfoCalls++;
        if (tokenInfoDown) return new Response("bad gateway", { status: 502 });
        const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const t = tokens[token] ?? { status: 401, body: { error: "invalid_token" } };
        return Response.json(t.body, { status: t.status ?? 200 });
      },
      "/api/v4/projects": (req) => {
        apiAuth.push(req.headers.get("authorization"), req.headers.get("private-token"));
        return Response.json([{ id: 1, path_with_namespace: "grp/app" }]);
      },
    },
  });
  config = gitlabOAuthConfigFromEnv({ GITLAB_URL: `${gitlab.url.origin}/`, GITLAB_OAUTH_CLIENT_ID: APP_ID })!;
  mcp = startHttpServer({
    port: 0,
    publicUrl: "https://mcp.example.com",
    gitlab: new GitLabClient(config.url, null),
    auth: gitlabOAuthProvider(config),
  });
});

afterAll(() => {
  mcp.stop(true);
  gitlab.stop(true);
});

beforeEach(() => {
  tokenInfoCalls = 0;
  apiAuth = [];
  tokenInfoDown = false;
});

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

const searchProjects = (token?: string) =>
  rpc("tools/call", { name: "search_projects", arguments: { search: "app" } }, token);

test("config defaults: GitLab is the issuer, read_api is required", () => {
  expect(gitlabOAuthConfigFromEnv({})).toBeNull();
  expect(config).toMatchObject({ url: gitlab.url.origin, issuer: gitlab.url.origin, clientId: APP_ID, scopes: ["read_api"] });
  expect(gitlabOAuthConfigFromEnv({ GITLAB_OAUTH_CLIENT_ID: "x", GITLAB_OAUTH_ISSUER: "https://public" })?.issuer).toBe("https://public");
});

test("metadata sends clients to GitLab, 401 asks for read_api", async () => {
  const prm = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", mcp.url));
  expect(await prm.json()).toMatchObject({ authorization_servers: [gitlab.url.origin], scopes_supported: ["read_api"] });
  const res = await searchProjects();
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toContain('scope="read_api"');
});

test("calls GitLab with the user's token, never a server PAT", async () => {
  const res = await searchProjects("user-token");
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.result.isError).toBeFalsy();
  expect(apiAuth).toEqual(["Bearer user-token", null]);
});

test("rejects PATs, other apps' tokens and missing scopes", async () => {
  for (const token of ["glpat-abc", "other-app", "no-scope", "garbage"]) {
    const res = await searchProjects(token);
    expect(res.status).toBe(401);
  }
  expect(apiAuth).toEqual([]);
  const res = await searchProjects("other-app");
  expect(res.headers.get("www-authenticate")).toContain(`Token was not issued to GitLab application ${APP_ID}`);
});

test("GitLab down during token check is a 503, not a 401", async () => {
  tokenInfoDown = true;
  const res = await searchProjects("down-check-token");
  expect(res.status).toBe(503);
});

test("validated tokens are cached until TTL or expiry", async () => {
  let clock = 1_000_000;
  const verify = createGitLabTokenVerifier({ ...config, cacheTtlMs: 60_000 }, () => clock);
  const info = await verify("user-token");
  expect(info).toMatchObject({ clientId: APP_ID, scopes: ["read_api"], expiresAt: 1000 + 7200, extra: { sub: "7" } });
  await verify("user-token");
  expect(tokenInfoCalls).toBe(1);
  clock += 61_000;
  await verify("user-token");
  expect(tokenInfoCalls).toBe(2);
});

test("boot check compares GitLab's issuer with the advertised one", async () => {
  expect(await checkGitLabOAuth(config)).toContain(`issuer ${gitlab.url.origin}`);
  await expect(checkGitLabOAuth({ ...config, issuer: "https://elsewhere" })).rejects.toThrow(/GITLAB_OAUTH_ISSUER/);
});
