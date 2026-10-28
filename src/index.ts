#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { list, oidcConfigFromEnv, oidcProvider, type AuthProvider } from "./auth.ts";
import { GitLabClient } from "./gitlab.ts";
import { checkGitLabOAuth, gitlabOAuthConfigFromEnv, gitlabOAuthProvider } from "./gitlab-oauth.ts";
import { startHttpServer } from "./http.ts";
import { SERVER_NAME, createMcpServer, type VictoriaClients } from "./server.ts";
import type { VictoriaHttpClient } from "./victoria.ts";
import { VictoriaLogsClient } from "./victorialogs.ts";
import { VictoriaMetricsClient } from "./victoriametrics.ts";

// stdout is the MCP channel in stdio mode: log to stderr only.
const transport = process.env.MCP_TRANSPORT ?? "stdio";
const gitlabUrl = process.env.GITLAB_URL ?? "https://gitlab.com";

// Surface connectivity/config problems at boot instead of on the first tool call.
const bootCheck = (label: string, url: string, check: Promise<string>) =>
  check.then(
    (detail) => console.error(`${label} OK (${url}): ${detail}`),
    (err) => console.error(`${label} check FAILED: ${err instanceof Error ? err.message : err}`),
  );
const checkPat = (gitlab: GitLabClient) => bootCheck("GitLab", gitlabUrl, gitlab.whoami().then((user) => `as ${user}`));

/** `forwarded`: each request carries the caller's realm token, so there is nothing to check at boot. */
function announce(name: string, prefix: string, client: VictoriaHttpClient | null, forwarded: boolean, check: () => Promise<string>) {
  if (!client) return;
  if (forwarded && client.bearer) console.error(`${prefix}_TOKEN is ignored: ${name} is called with each user's OIDC token`);
  const mode = forwarded ? "forwarded user token" : client.bearer ? "static token" : "none";
  console.error(`${name} tools enabled (${client.baseUrl}, auth: ${mode})`);
  if (!forwarded) bootCheck(name, client.baseUrl, check());
}

function setupVictoria(forwarded: boolean): VictoriaClients {
  const logs = VictoriaLogsClient.fromEnv();
  const metrics = VictoriaMetricsClient.fromEnv();
  announce("VictoriaLogs", "VICTORIALOGS", logs, forwarded, () =>
    logs!.fieldNames({ query: "*", start: "-5m" }).then((f) => `${f.length} fields in the last 5m`),
  );
  announce("VictoriaMetrics", "VICTORIAMETRICS", metrics, forwarded, () =>
    metrics!.query("vector(1)").then(() => "query OK"),
  );
  return { logs, metrics };
}

if (transport === "stdio") {
  const gitlab = GitLabClient.fromEnv();
  checkPat(gitlab);
  const victoria = setupVictoria(false);
  await createMcpServer(gitlab, victoria).connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} running on stdio`);
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
      bootCheck("GitLab OAuth", gitlabUrl, checkGitLabOAuth(gitlabOAuth));
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
  const victoria = setupVictoria(auth?.kind === "oidc");

  const dcrShim = process.env.MCP_DCR_SHIM !== "false";
  const redirectAllowlist = list(process.env.MCP_REDIRECT_URIS);
  const server = startHttpServer({ port, publicUrl, gitlab, victoria, auth, debug, dcrShim, redirectAllowlist });
  const mode = auth ? `${auth.kind} via ${auth.issuer}` : "DISABLED";
  if (auth && dcrShim && auth.publicClientId) {
    console.error(`DCR shim on: client registrations get client_id ${auth.publicClientId} (MCP_DCR_SHIM=false to disable)`);
  } else if (auth && dcrShim) {
    console.error("DCR shim off: set OIDC_CLIENT_ID so MCP clients get the pre-registered client automatically");
  }
  console.error(`${SERVER_NAME} listening on ${server.url} (public: ${publicUrl}, auth: ${mode})`);
} else {
  throw new Error(`Unknown MCP_TRANSPORT "${transport}" (expected stdio or http)`);
}
