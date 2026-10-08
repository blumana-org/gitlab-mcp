#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { oidcConfigFromEnv, oidcProvider, type AuthProvider } from "./auth.ts";
import { GitLabClient } from "./gitlab.ts";
import { checkGitLabOAuth, gitlabOAuthConfigFromEnv, gitlabOAuthProvider } from "./gitlab-oauth.ts";
import { startHttpServer } from "./http.ts";
import { createMcpServer } from "./server.ts";

// stdout is the MCP channel in stdio mode: log to stderr only.
const transport = process.env.MCP_TRANSPORT ?? "stdio";
const gitlabUrl = process.env.GITLAB_URL ?? "https://gitlab.com";

// Surface GitLab connectivity/config problems at boot instead of on the first tool call.
const bootCheck = (label: string, check: Promise<string>) =>
  check.then(
    (detail) => console.error(`${label} OK (${gitlabUrl}): ${detail}`),
    (err) => console.error(`${label} check FAILED: ${err instanceof Error ? err.message : err}`),
  );
const checkPat = (gitlab: GitLabClient) => bootCheck("GitLab", gitlab.whoami().then((user) => `as ${user}`));

if (transport === "stdio") {
  const gitlab = GitLabClient.fromEnv();
  checkPat(gitlab);
  await createMcpServer(gitlab).connect(new StdioServerTransport());
  console.error("gitlab-mcp running on stdio");
} else if (transport === "http") {
  const port = Number(process.env.PORT ?? 3000);
  const publicUrl = process.env.MCP_PUBLIC_URL ?? `http://localhost:${port}`;
  const debug = process.env.MCP_DEBUG === "true";

  let auth: AuthProvider | null = null;
  if (process.env.MCP_AUTH_DISABLED !== "true") {
    const gitlabOAuth = gitlabOAuthConfigFromEnv();
    const oidc = oidcConfigFromEnv();
    if (gitlabOAuth && oidc) throw new Error("Set GITLAB_OAUTH_CLIENT_ID (GitLab login) or OIDC_ISSUER (SSO), not both");
    if (gitlabOAuth) {
      auth = gitlabOAuthProvider(gitlabOAuth);
      bootCheck("GitLab OAuth", checkGitLabOAuth(gitlabOAuth));
    } else if (oidc) {
      auth = oidcProvider(oidc);
    } else {
      throw new Error("HTTP mode requires GITLAB_OAUTH_CLIENT_ID or OIDC_ISSUER (or MCP_AUTH_DISABLED=true for local dev)");
    }
  }

  // GitLab login: every call uses the caller's token, the server holds no GitLab credentials.
  const perUser = auth?.kind === "gitlab";
  const gitlab = GitLabClient.fromEnv(process.env, { requireToken: !perUser });
  if (perUser && process.env.GITLAB_TOKEN) console.error("GITLAB_TOKEN is ignored: GitLab is called with each user's OAuth token");
  if (!perUser) checkPat(gitlab);

  const server = startHttpServer({ port, publicUrl, gitlab, auth, debug });
  const mode = auth ? `${auth.kind} via ${auth.issuer}` : "DISABLED";
  console.error(`gitlab-mcp listening on ${server.url} (public: ${publicUrl}, auth: ${mode})`);
} else {
  throw new Error(`Unknown MCP_TRANSPORT "${transport}" (expected stdio or http)`);
}
