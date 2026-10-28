import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safe } from "./tool-utils.ts";
import { TIME_HINT } from "./victoria.ts";
import { formatInstant, formatLabelValues, formatRange, formatSeries, formatTargets } from "./victoria-format.ts";
import type { VictoriaMetricsClient } from "./victoriametrics.ts";

const promql = z.string().describe("PromQL/MetricsQL expression");
const start = z.string().default("-1h").describe(`Range start. ${TIME_HINT}`);
const end = z.string().default("now").describe(`Range end. ${TIME_HINT}`);

export function registerVictoriaMetricsTools(server: McpServer, vm: VictoriaMetricsClient) {
  server.registerTool(
    "query_metrics",
    {
      title: "Query metrics (instant)",
      description:
        "Run an instant PromQL/MetricsQL query on VictoriaMetrics: one value per matching series. " +
        "For a current value or an aggregate over a window (e.g. `up`, `sum(rate(http_requests_total[5m])) by (job)`).",
      inputSchema: {
        query: promql,
        time: z.string().optional().describe(`Evaluation instant (default now). ${TIME_HINT}`),
        limit: z.number().int().min(1).max(2000).default(50).describe("Max series returned"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("query_metrics", async ({ query, time, limit }) => {
      const data = await vm.query(query, time);
      // A scalar/string result has no per-series shape: report it verbatim.
      if (data.resultType !== "vector" && data.resultType !== "matrix") return `${data.resultType}: ${JSON.stringify(data.result)}`;
      return formatInstant(data.result, limit);
    }),
  );

  server.registerTool(
    "query_metrics_range",
    {
      title: "Query metrics over time",
      description:
        "Run a PromQL/MetricsQL query over a time range: per series min/max/avg/last plus evenly subsampled points. Use it to see how a metric evolved.",
      inputSchema: {
        query: promql,
        start,
        end,
        step: z.string().optional().describe('Resolution such as "30s", "1m", "1h" (default: ~60 points over the range)'),
        max_series: z.number().int().min(1).max(200).default(10).describe("Max series detailed"),
        max_points: z.number().int().min(2).max(500).default(20).describe("Max points shown per series"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("query_metrics_range", async ({ query, start, end, step, max_series, max_points }) => {
      const { result, stepSeconds } = await vm.queryRange({ query, start, end, step });
      return `range ${start} → ${end}, step ${stepSeconds}s\n\n${formatRange(result, max_series, max_points)}`;
    }),
  );

  server.registerTool(
    "list_metric_series",
    {
      title: "List metric series",
      description: 'List the label sets of series matching selectors, to discover which metrics and labels exist (e.g. match=["up"] or ["{job=\\"node\\"}"]).',
      inputSchema: {
        match: z.array(z.string()).min(1).describe('Series selectors, e.g. ["up", "{job=\\"node\\"}"]'),
        start,
        end,
        limit: z.number().int().min(1).max(2000).default(100).describe("Max series returned"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("list_metric_series", async ({ match, start, end, limit }) => formatSeries(await vm.series({ match, start, end }), limit)),
  );

  server.registerTool(
    "list_metric_label_values",
    {
      title: "List metric label values",
      description: 'List the values of a label, optionally restricted to series matching selectors. `label="__name__"` lists metric names.',
      inputSchema: {
        label: z.string().describe('Label name, e.g. "job", "instance", "__name__"'),
        match: z.array(z.string()).optional().describe('Optional series selectors, e.g. ["up"]'),
        start,
        end,
        limit: z.number().int().min(1).max(5000).default(200).describe("Max values returned"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("list_metric_label_values", async ({ label, match, start, end, limit }) =>
      formatLabelValues(label, await vm.labelValues({ label, match, start, end }), limit),
    ),
  );

  server.registerTool(
    "list_scrape_targets",
    {
      title: "List scrape targets",
      description: "Scrape target health (job, instance, health, last error). Check it before concluding a metric is missing.",
      inputSchema: { only_unhealthy: z.boolean().default(false).describe("Only targets that are not up") },
      annotations: { readOnlyHint: true },
    },
    safe("list_scrape_targets", async ({ only_unhealthy }) => formatTargets(await vm.targets(), only_unhealthy)),
  );
}
