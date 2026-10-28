import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitLabClient } from "../src/gitlab.ts";
import { createMcpServer } from "../src/server.ts";

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

async function callTool(name: string, args: Record<string, unknown>) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(new GitLabClient("https://gitlab.test", "t")).connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const res = (await client.callTool({ name, arguments: args })) as any;
  await client.close();
  const text: string = res.content[0].text;
  return { isError: res.isError, text, data: res.isError ? undefined : JSON.parse(text) };
}

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
