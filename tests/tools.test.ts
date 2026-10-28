import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitLabClient } from "../src/gitlab.ts";
import { createMcpServer, type VictoriaClients } from "../src/server.ts";
import { VictoriaLogsClient } from "../src/victorialogs.ts";
import { VictoriaMetricsClient } from "../src/victoriametrics.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Routes fetch by API path (without /api/v4 prefix and query string). */
function mockGitLab(routes: Record<string, unknown>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v4/, "");
    calls.push(path + url.search);
    if (!(path in routes)) return new Response("not found", { status: 404 });
    return Response.json(routes[path], { headers: { "x-page": "1", "x-per-page": "20" } });
  }) as typeof fetch;
  return calls;
}

const allBackends: VictoriaClients = {
  logs: new VictoriaLogsClient("https://logs.test", null),
  metrics: new VictoriaMetricsClient("https://metrics.test", null),
};

async function connect(victoria: VictoriaClients = allBackends) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(new GitLabClient("https://gitlab.test", "t"), victoria).connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const client = await connect();
  const res = (await client.callTool({ name, arguments: args })) as any;
  await client.close();
  const text: string = res.content[0].text;
  let data: any;
  try {
    data = res.isError ? undefined : JSON.parse(text);
  } catch {
    // Victoria tools answer in compact text.
  }
  return { isError: res.isError, text, data };
}

/** Records each Victoria request (path + form body) and answers with `reply(path)`. */
function mockVictoria(reply: (path: string) => Response) {
  const calls: { path: string; form: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) });
    return reply(path);
  }) as typeof fetch;
  return calls;
}

const ago = (form: Record<string, string>, key: string) => Math.round((Date.now() / 1000 - Number(form[key])) / 60);

test("list_registry_repositories requests tag counts", async () => {
  const calls = mockGitLab({
    "/projects/grp%2Fapp/registry/repositories": [
      { id: 7, name: "", path: "grp/app", location: "registry.test/grp/app", tags_count: 3, created_at: "x", project_id: 1 },
    ],
  });
  const { data } = await callTool("list_registry_repositories", { project: "grp/app" });
  expect(calls[0]).toContain("tags_count=true");
  expect(data.items).toEqual([{ id: 7, name: "", path: "grp/app", location: "registry.test/grp/app", tags_count: 3, created_at: "x" }]);
});

test("list_registry_tags fetches details when asked", async () => {
  const base = "/projects/1/registry/repositories/7/tags";
  mockGitLab({
    [base]: [{ name: "latest", location: "registry.test/grp/app:latest" }],
    [`${base}/latest`]: { name: "latest", location: "registry.test/grp/app:latest", digest: "sha256:abc", total_size: 42, created_at: "t", revision: "r" },
  });

  const plain = await callTool("list_registry_tags", { project: 1, repository_id: 7 });
  expect(plain.data.items).toEqual([{ name: "latest", location: "registry.test/grp/app:latest" }]);

  const detailed = await callTool("list_registry_tags", { project: 1, repository_id: 7, include_details: true });
  expect(detailed.data.items).toEqual([
    { name: "latest", location: "registry.test/grp/app:latest", digest: "sha256:abc", total_size: 42, created_at: "t" },
  ]);
});

test("GitLab errors come back as tool errors", async () => {
  mockGitLab({});
  const res = await callTool("list_registry_repositories", { project: 999 });
  expect(res.isError).toBe(true);
  expect(res.text).toContain("GitLab API 404");
});

test("Victoria tools are only registered when configured", async () => {
  const names = async (victoria: VictoriaClients) => {
    const client = await connect(victoria);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name);
  };
  const none = await names({});
  expect(none).not.toContain("query_logs");
  expect(none).not.toContain("query_metrics");
  expect(await names({ logs: allBackends.logs })).not.toContain("query_metrics");
  expect(await names(allBackends)).toEqual(
    expect.arrayContaining([
      "query_logs", "log_hits", "list_log_fields", "list_log_field_values",
      "query_metrics", "query_metrics_range", "list_metric_series", "list_metric_label_values", "list_scrape_targets",
      "get_job",
    ]),
  );
});

test("query_logs defaults to the last hour and renders compact lines", async () => {
  const calls = mockVictoria(() => new Response(`{"_time":"2026-01-01T00:00:00Z","_msg":"${"x".repeat(150)}","level":"error"}\n`));
  const { text } = await callTool("query_logs", { query: "error", max_message_chars: 100 });
  expect(calls[0]!.path).toBe("/select/logsql/query");
  expect(ago(calls[0]!.form, "start")).toBe(60);
  expect(calls[0]!.form.limit).toBe("100");
  expect(text).toBe(`1 entries, newest first\n2026-01-01T00:00:00Z ${"x".repeat(100)}…(+50 chars) | level=error`);
});

test("log_hits passes step and grouping field", async () => {
  const calls = mockVictoria(() => Response.json({ hits: [{ fields: { app: "api" }, timestamps: ["2026-01-01T00:00:00Z"], values: [3], total: 3 }] }));
  const { text } = await callTool("log_hits", { query: "error", step: "5m", field: "app" });
  expect(calls[0]!.path).toBe("/select/logsql/hits");
  expect(calls[0]!.form).toMatchObject({ query: "error", step: "300s", field: "app" });
  expect(ago(calls[0]!.form, "start")).toBe(24 * 60);
  expect(text).toContain('{app="api"} total=3');
});

test("query_metrics renders one line per series", async () => {
  const calls = mockVictoria(() =>
    Response.json({ status: "success", data: { resultType: "vector", result: [{ metric: { __name__: "up", job: "node" }, value: [1_800_000_000, "1"] }] } }),
  );
  const { text, isError } = await callTool("query_metrics", { query: "up" });
  expect(isError).toBeFalsy();
  expect(calls[0]).toEqual({ path: "/api/v1/query", form: { query: "up" } });
  expect(text).toBe('1 series at 2027-01-15T08:00:00Z\nup{job="node"} = 1');
});

test("query_metrics_range reports bad times as tool errors without calling the backend", async () => {
  const calls = mockVictoria(() => new Response("unexpected"));
  const res = await callTool("query_metrics_range", { query: "up", start: "last tuesday" });
  expect(res.isError).toBe(true);
  expect(res.text).toContain("cannot parse time");
  expect(calls).toEqual([]);
});

test("list_scrape_targets can keep only unhealthy targets", async () => {
  mockVictoria(() =>
    Response.json({
      status: "success",
      data: { activeTargets: [{ labels: { job: "a", instance: "1" }, health: "up" }, { labels: { job: "b", instance: "2" }, health: "down" }] },
    }),
  );
  const { text } = await callTool("list_scrape_targets", { only_unhealthy: true });
  expect(text).toBe("2 targets, 1 not up\nDOWN    b / 2");
});
