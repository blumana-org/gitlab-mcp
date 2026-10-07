#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTokenVerifier, oidcConfigFromEnv } from "./auth.ts";
import { GitLabClient } from "./gitlab.ts";
import { startHttpServer } from "./http.ts";
import { createMcpServer } from "./server.ts";

// stdout is the MCP channel in stdio mode: log to stderr only.
const gitlab = GitLabClient.fromEnv();
const transport = process.env.MCP_TRANSPORT ?? "stdio";

// Surface GitLab connectivity/token problems at boot instead of on the first tool call.
gitlab.whoami().then(
  (user) => console.error(`GitLab OK (${process.env.GITLAB_URL ?? "https://gitlab.com"}) as ${user}`),
  (err) => console.error(`GitLab check FAILED: ${err instanceof Error ? err.message : err}`),
);

if (transport === "stdio") {
  await createMcpServer(gitlab).connect(new StdioServerTransport());
  console.error("gitlab-mcp running on stdio");
} else if (transport === "http") {
  const port = Number(process.env.PORT ?? 3000);
  const publicUrl = process.env.MCP_PUBLIC_URL ?? `http://localhost:${port}`;
  const oidc = oidcConfigFromEnv();
  if (!oidc && process.env.MCP_AUTH_DISABLED !== "true") {
    throw new Error("HTTP mode requires OIDC_ISSUER (or MCP_AUTH_DISABLED=true for local dev)");
  }
  const auth = oidc ? { config: oidc, verify: createTokenVerifier(oidc) } : null;
  const debug = process.env.MCP_DEBUG === "true";
  const server = startHttpServer({ port, publicUrl, gitlab, auth, debug });
  console.error(`gitlab-mcp listening on ${server.url} (public: ${publicUrl}, auth: ${oidc ? oidc.issuer : "DISABLED"})`);
} else {
  throw new Error(`Unknown MCP_TRANSPORT "${transport}" (expected stdio or http)`);
}
