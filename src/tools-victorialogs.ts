import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safe } from "./tool-utils.ts";
import { TIME_HINT } from "./victoria.ts";
import { formatFieldValues, formatHits, formatLogs } from "./victoria-format.ts";
import type { VictoriaLogsClient } from "./victorialogs.ts";

const query = z
  .string()
  .describe(
    'LogsQL query. Examples: `error`, `{app="api"} AND level:error`, `"connection refused" | fields _time, _msg, pod`. ' +
      "Words are matched in _msg; `field:value` filters a field; `{...}` filters log streams.",
  );
const start = z.string().describe(`Range start. ${TIME_HINT}`);
const end = z.string().optional().describe(`Range end (default now). ${TIME_HINT}`);

export function registerVictoriaLogsTools(server: McpServer, vl: VictoriaLogsClient) {
  server.registerTool(
    "query_logs",
    {
      title: "Query logs",
      description:
        "Search application logs in VictoriaLogs with a LogsQL query. Returns one compact line per entry, newest first " +
        "(time, [container], message, extra fields). Use list_log_fields / list_log_field_values to discover fields (app, pod, level...).",
      inputSchema: {
        query,
        start: start.default("-1h"),
        end,
        limit: z.number().int().min(1).max(1000).default(100).describe("Max entries returned (most recent)"),
        max_message_chars: z.number().int().min(50).max(20_000).default(1000).describe("Truncate each message beyond this length"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("query_logs", async ({ query, start, end, limit, max_message_chars }) =>
      formatLogs(await vl.query({ query, start, end, limit }), max_message_chars, limit),
    ),
  );

  server.registerTool(
    "log_hits",
    {
      title: "Log hits over time",
      description:
        "Count matching log entries per time bucket, optionally grouped by a field. Use it to see when errors started or which service emits them.",
      inputSchema: {
        query,
        start: start.default("-24h"),
        end,
        step: z.string().default("1h").describe("Bucket size, e.g. 5m, 1h"),
        field: z.string().optional().describe("Group counts by this field (e.g. app, level)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("log_hits", async ({ query, start, end, step, field }) => formatHits(await vl.hits({ query, start, end, step, field }), step)),
  );

  server.registerTool(
    "list_log_fields",
    {
      title: "List log fields",
      description: "List the field names present in logs matching a query, with their number of hits.",
      inputSchema: { query: query.default("*"), start: start.default("-1h"), end },
      annotations: { readOnlyHint: true },
    },
    safe("list_log_fields", async ({ query, start, end }) => formatFieldValues("fields", await vl.fieldNames({ query, start, end }))),
  );

  server.registerTool(
    "list_log_field_values",
    {
      title: "List log field values",
      description: "List the distinct values of a field in logs matching a query (e.g. every app or pod name), with their number of hits.",
      inputSchema: {
        query: query.default("*"),
        field: z.string().describe("Field name, e.g. app, level, kubernetes.pod_name"),
        start: start.default("-1h"),
        end,
        limit: z.number().int().min(1).max(1000).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    safe("list_log_field_values", async ({ query, field, start, end, limit }) =>
      formatFieldValues(`values for "${field}"`, await vl.fieldValues({ query, field, start, end, limit }), limit),
    ),
  );
}
