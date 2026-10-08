import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { AuthUnavailableError, protectedResourceMetadata, type AuthProvider } from "./auth.ts";
import type { GitLabClient } from "./gitlab.ts";
import { createMcpServer } from "./server.ts";

export interface HttpOptions {
  port: number;
  /** Public base URL of this server, e.g. https://gitlab-mcp.example.com */
  publicUrl: string;
  /** With GitLab OAuth auth, carries no token: each request calls GitLab as its caller. */
  gitlab: GitLabClient;
  /** Log every auth decision, not only rejections. */
  debug?: boolean;
  /** null = authentication disabled (dev only). */
  auth: AuthProvider | null;
}

const PRM_PATH = "/.well-known/oauth-protected-resource";

export function startHttpServer({ port, publicUrl, gitlab, auth, debug = false }: HttpOptions) {
  const base = publicUrl.replace(/\/+$/, "");
  const resource = `${base}/mcp`;
  const metadataUrl = `${base}${PRM_PATH}/mcp`;

  const scope = auth?.scopes.length ? `, scope="${auth.scopes.join(" ")}"` : "";
  const unauthorized = (error: string, description: string) => {
    description = description.replace(/["\\\r\n]/g, "'");
    return Response.json(
      { error, error_description: description },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer error="${error}", error_description="${description}", resource_metadata="${metadataUrl}"${scope}`,
        },
      },
    );
  };

  async function authenticate(req: Request): Promise<AuthInfo | Response | undefined> {
    if (!auth) return undefined;
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      if (debug) console.error(`[auth] ${req.method} /mcp without bearer token -> 401 (normal first step of the OAuth flow)`);
      return unauthorized("invalid_request", "Missing bearer token");
    }
    try {
      const info = await auth.verify(match[1]!);
      if (debug) console.error(`[auth] accepted token for sub=${info.extra?.sub} client=${info.clientId}`);
      return info;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof AuthUnavailableError) {
        // Not the token's fault: a 401 would make the client throw away a valid login.
        console.error(`[auth] cannot validate token: ${reason}`);
        return Response.json({ error: "temporarily_unavailable", error_description: reason }, { status: 503 });
      }
      // Expected values vs what the token carries: that's what you need to fix a mismatch.
      console.error(
        `[auth] token rejected: ${reason}`,
        JSON.stringify({ expected: auth.expected, got: auth.describe(match[1]!) }),
      );
      return unauthorized("invalid_token", `Token rejected: ${reason}`);
    }
  }

  // Always-on access log: if a call never shows up here, it never reached this container.
  async function handleMcp(req: Request): Promise<Response> {
    const start = performance.now();
    const res = await serveMcp(req).catch((err) => {
      console.error("[http] /mcp crashed:", err);
      return new Response("Internal error", { status: 500 });
    });
    const who = req.headers.get("authorization") ? "bearer" : "anonymous";
    console.error(`[http] ${req.method} /mcp ${res.status} ${Math.round(performance.now() - start)}ms (${who})`);
    return res;
  }

  async function serveMcp(req: Request): Promise<Response> {
    const authInfo = await authenticate(req);
    if (authInfo instanceof Response) return authInfo;

    // GitLab login: the user's own token, validated as issued to our GitLab app, so GitLab enforces their permissions.
    const gl = auth?.kind === "gitlab" && authInfo ? gitlab.asUser(authInfo.token) : gitlab;
    // Stateless: one server + transport per request, so any replica can serve any call.
    const server = createMcpServer(gl);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req, { authInfo });
    } finally {
      await server.close();
    }
  }

  const prm = (req: Request) => {
    if (debug) console.error(`[auth] metadata requested: ${new URL(req.url).pathname}`);
    return auth ? Response.json(protectedResourceMetadata(auth, resource)) : new Response("Not found", { status: 404 });
  };

  return Bun.serve({
    port,
    routes: {
      "/health": new Response("ok"),
      [PRM_PATH]: prm,
      [`${PRM_PATH}/mcp`]: prm,
      "/mcp": handleMcp,
    },
    fetch: (req) => {
      // Clients probing other well-known paths (e.g. authorization server metadata on the wrong host) land here.
      if (debug) console.error(`[http] 404 ${req.method} ${new URL(req.url).pathname}`);
      return new Response("Not found", { status: 404 });
    },
  });
}
