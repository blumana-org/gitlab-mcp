import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import type { GitLabClient } from "./gitlab.ts";
import { registerTools } from "./tools.ts";

export function createMcpServer(gl: GitLabClient): McpServer {
  const server = new McpServer({ name: "gitlab-mcp", version: pkg.version });
  registerTools(server, gl);
  return server;
}
