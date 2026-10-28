import { afterAll, beforeAll, expect, test } from "bun:test";
import { VictoriaLogsClient, parseNdjson } from "../src/victorialogs.ts";

let vl: ReturnType<typeof Bun.serve>;
const seen: { path: string; method: string; form: URLSearchParams; auth: string | null }[] = [];

beforeAll(() => {
  vl = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      seen.push({ path, method: req.method, form: new URLSearchParams(await req.text()), auth: req.headers.get("authorization") });
      switch (path) {
        case "/select/logsql/query":
          return new Response('{"_time":"2026-01-01T00:00:01Z","_msg":"old"}\n{"_time":"2026-01-01T00:00:03Z","_msg":"new"}\n\n{"_time":"2026-01-');
        case "/select/logsql/field_names":
          return Response.json({ values: [{ value: "_msg", hits: 2 }] });
        case "/select/logsql/hits":
          return Response.json({ hits: [{ fields: {}, timestamps: ["t"], values: [1], total: 1 }] });
        case "/redirect/select/logsql/query":
          return new Response(null, { status: 302, headers: { location: "/oauth2/sign_in" } });
        case "/forbidden/select/logsql/query":
          return new Response("Forbidden", { status: 403 });
        case "/slow/select/logsql/query":
          await Bun.sleep(200);
          return new Response("");
        default:
          return Response.json({ error: "bad query" }, { status: 400 });
      }
    },
  });
});

afterAll(() => vl.stop(true));

const base = () => vl.url.origin;

test("query POSTs a form with the bearer, returns entries newest first and counts bad lines", async () => {
  const client = new VictoriaLogsClient(`${base()}/`, "user-jwt");
  const before = Math.floor(Date.now() / 1000);
  const { entries, skipped } = await client.query({ query: '{app="api"} error', start: "-1h", limit: 10 });
  expect(entries.map((e) => e._msg)).toEqual(["new", "old"]);
  expect(skipped).toBe(1);
  const last = seen.at(-1)!;
  expect(last.method).toBe("POST");
  expect(last.auth).toBe("Bearer user-jwt");
  expect(last.form.get("query")).toBe('{app="api"} error');
  expect(Number(last.form.get("start"))).toBeWithin(before - 3601, before - 3598);
  expect(last.form.get("limit")).toBe("10");
  expect(last.form.has("end")).toBe(false);
});

test("hits sends the step in seconds", async () => {
  await new VictoriaLogsClient(base(), null).hits({ query: "*", step: "5m", field: "app" });
  expect(Object.fromEntries(seen.at(-1)!.form)).toMatchObject({ step: "300s", field: "app" });
});

test("no credentials sends no authorization header", async () => {
  expect(await new VictoriaLogsClient(base(), null).fieldNames({ query: "*" })).toEqual([{ value: "_msg", hits: 2 }]);
  expect(seen.at(-1)!.auth).toBeNull();
});

test("asUser swaps the bearer", async () => {
  await new VictoriaLogsClient(base(), "static").asUser("user-jwt").fieldNames({ query: "*" });
  expect(seen.at(-1)!.auth).toBe("Bearer user-jwt");
});

test("oauth2-proxy redirects and 403 are reported as auth failures", async () => {
  for (const prefix of ["redirect", "forbidden"]) {
    const client = new VictoriaLogsClient(`${base()}/${prefix}`, "t");
    await expect(client.query({ query: "*", limit: 1 })).rejects.toThrow(/oauth2-proxy\) rejected the token/);
  }
});

test("errors extract the JSON error field; timeouts are explicit", async () => {
  await expect(new VictoriaLogsClient(base(), null).fieldValues({ query: "(", field: "x", limit: 1 })).rejects.toThrow(
    "VictoriaLogs 400 on /select/logsql/field_values: bad query",
  );
  await expect(new VictoriaLogsClient(`${base()}/slow`, null, 20).query({ query: "*", limit: 1 })).rejects.toThrow("unreachable at");
});

test("invalid times are rejected before any request", async () => {
  const count = seen.length;
  await expect(new VictoriaLogsClient(base(), null).query({ query: "*", start: "yesterday", limit: 1 })).rejects.toThrow("cannot parse time");
  expect(seen.length).toBe(count);
});

test("fromEnv is null without VICTORIALOGS_URL", () => {
  expect(VictoriaLogsClient.fromEnv({})).toBeNull();
  const client = VictoriaLogsClient.fromEnv({ VICTORIALOGS_URL: "https://logs/", VICTORIALOGS_TOKEN: "s" })!;
  expect(client.baseUrl).toBe("https://logs");
  expect(client.bearer).toBe("s");
});

test("parseNdjson skips blank lines and counts malformed ones", () => {
  expect(parseNdjson('{"a":1}\n\n{"a":2}\n{oops')).toEqual({ entries: [{ a: 1 }, { a: 2 }] as any, skipped: 1 });
});
