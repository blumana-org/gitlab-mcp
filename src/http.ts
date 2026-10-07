import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { protectedResourceMetadata, type OidcConfig, type TokenVerifier } from "./auth.ts";
import type { GitLabClient } from "./gitlab.ts";
import { createMcpServer } from "./server.ts";

export interface HttpOptions {
  port: number;
  /** Public base URL of this server, e.g. https://gitlab-mcp.example.com */
  publicUrl: string;
  gitlab: GitLabClient;
  /** null = authentication disabled (dev only). */
  auth: { config: OidcConfig; verify: TokenVerifier } | null;
}

const PRM_PATH = "/.well-known/oauth-protected-resource";

export function startHttpServer({ port, publicUrl, gitlab, auth }: HttpOptions) {
  const base = publicUrl.replace(/\/+$/, "");
  const resource = `${base}/mcp`;
  const metadataUrl = `${base}${PRM_PATH}/mcp`;

  const unauthorized = (error: string, description: string) =>
    Response.json(
      { error, error_description: description },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer error="${error}", error_description="${description}", resource_metadata="${metadataUrl}"`,
        },
      },
    );

  async function authenticate(req: Request): Promise<AuthInfo | Response | undefined> {
    if (!auth) return undefined;
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return unauthorized("invalid_request", "Missing bearer token");
    try {
      return await auth.verify(match[1]!);
    } catch (err) {
      console.error("token rejected:", err instanceof Error ? err.message : err);
      return unauthorized("invalid_token", "Invalid or expired token");
    }
  }

  async function handleMcp(req: Request): Promise<Response> {
    const authInfo = await authenticate(req);
    if (authInfo instanceof Response) return authInfo;

    // Stateless: one server + transport per request, so any replica can serve any call.
    const server = createMcpServer(gitlab);
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

  const prm = () =>
    auth ? Response.json(protectedResourceMetadata(auth.config, resource)) : new Response("Not found", { status: 404 });

  return Bun.serve({
    port,
    routes: {
      "/health": new Response("ok"),
      [PRM_PATH]: prm,
      [`${PRM_PATH}/mcp`]: prm,
      "/mcp": handleMcp,
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
}
