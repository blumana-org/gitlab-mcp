import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import type { GitLabClient } from "./gitlab.ts";
import { registerTools } from "./tools.ts";
import { registerVictoriaLogsTools } from "./tools-victorialogs.ts";
import { registerVictoriaMetricsTools } from "./tools-victoriametrics.ts";
import type { VictoriaLogsClient } from "./victorialogs.ts";
import type { VictoriaMetricsClient } from "./victoriametrics.ts";

export const SERVER_NAME = "devops-mcp";

/** Optional backends: their tools are only registered when configured. */
export interface VictoriaClients {
  logs?: VictoriaLogsClient | null;
  metrics?: VictoriaMetricsClient | null;
}

export function createMcpServer(gl: GitLabClient, victoria: VictoriaClients = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: pkg.version });
  registerTools(server, gl);
  if (victoria.logs) registerVictoriaLogsTools(server, victoria.logs);
  if (victoria.metrics) registerVictoriaMetricsTools(server, victoria.metrics);
  return server;
}
