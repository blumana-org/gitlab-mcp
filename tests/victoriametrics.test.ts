import { afterAll, beforeAll, expect, test } from "bun:test";
import { VictoriaMetricsClient } from "../src/victoriametrics.ts";

let vm: ReturnType<typeof Bun.serve>;
const seen: { path: string; form: URLSearchParams; auth: string | null }[] = [];
const ok = (data: unknown) => Response.json({ status: "success", data });

beforeAll(() => {
  vm = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      const form = new URLSearchParams(await req.text());
      seen.push({ path, form, auth: req.headers.get("authorization") });
      switch (path) {
        case "/api/v1/query":
          if (form.get("query") === "bad(") {
            return Response.json({ status: "error", errorType: "bad_data", error: "unparsable query" }, { status: 422 });
          }
          return ok({ resultType: "vector", result: [{ metric: { __name__: "up" }, value: [1, "1"] }] });
        case "/api/v1/query_range":
          return ok({ resultType: "matrix", result: [] });
        case "/api/v1/series":
          return ok([{ __name__: "up", job: "node" }]);
        case "/api/v1/label/__name__/values":
          return ok(["up"]);
        case "/api/v1/targets":
          return ok({ activeTargets: [{ labels: { job: "node" }, health: "up" }] });
        case "/inline-error/api/v1/query":
          return Response.json({ status: "error", error: "boom" });
        default:
          return new Response("nope", { status: 404 });
      }
    },
  });
});

afterAll(() => vm.stop(true));

const client = (bearer: string | null = null, prefix = "") => new VictoriaMetricsClient(`${vm.url.origin}${prefix}`, bearer);

test("query unwraps data and sends the bearer", async () => {
  const data = await client("jwt").query("up");
  expect(data).toEqual({ resultType: "vector", result: [{ metric: { __name__: "up" }, value: [1, "1"] }] });
  expect(seen.at(-1)).toMatchObject({ path: "/api/v1/query", auth: "Bearer jwt" });
  expect(seen.at(-1)!.form.has("time")).toBe(false);
});

test("query errors surface the Prometheus error message", async () => {
  await expect(client().query("bad(")).rejects.toThrow("VictoriaMetrics 422 on /api/v1/query: unparsable query");
  await expect(client(null, "/inline-error").query("up")).rejects.toThrow("VictoriaMetrics error: boom");
});

test("queryRange defaults to ~60 points and validates the range", async () => {
  const { stepSeconds } = await client().queryRange({ query: "up", start: "-1h", end: "now" });
  expect(stepSeconds).toBe(60);
  const form = seen.at(-1)!.form;
  expect(form.get("step")).toBe("60s");
  expect(Number(form.get("end")) - Number(form.get("start"))).toBe(3600);
  await expect(client().queryRange({ query: "up", start: "now", end: "-1h" })).rejects.toThrow("empty range");
});

test("series and label values use match[]", async () => {
  expect(await client().series({ match: ["up", '{job="x"}'] })).toEqual([{ __name__: "up", job: "node" }]);
  expect(seen.at(-1)!.form.getAll("match[]")).toEqual(["up", '{job="x"}']);
  expect(await client().labelValues({ label: "__name__" })).toEqual(["up"]);
  expect(await client().targets()).toEqual([{ labels: { job: "node" }, health: "up" }]);
  expect(seen.at(-1)!.form.get("state")).toBe("active");
});

test("asUser swaps the bearer; fromEnv needs VICTORIAMETRICS_URL", async () => {
  await client("static").asUser("user").query("up");
  expect(seen.at(-1)!.auth).toBe("Bearer user");
  expect(VictoriaMetricsClient.fromEnv({})).toBeNull();
  expect(VictoriaMetricsClient.fromEnv({ VICTORIAMETRICS_URL: "https://vm/", VICTORIAMETRICS_TOKEN: "t" })).toMatchObject({
    baseUrl: "https://vm",
    bearer: "t",
  });
});
