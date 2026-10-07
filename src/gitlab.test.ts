import { afterEach, expect, mock, test } from "bun:test";
import { GitLabClient, GitLabError, cleanLog, projectPath, tail } from "./gitlab.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(body: unknown, init: ResponseInit = {}) {
  const fn = mock(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), init),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

test("projectPath encodes full paths", () => {
  expect(projectPath("group/sub/proj")).toBe("/projects/group%2Fsub%2Fproj");
  expect(projectPath(42)).toBe("/projects/42");
});

test("getPage sends token, builds query and parses pagination headers", async () => {
  const fetchMock = mockFetch([{ id: 1 }], {
    headers: { "x-page": "2", "x-per-page": "10", "x-next-page": "3", "x-prev-page": "1", "x-total": "25", "x-total-pages": "3" },
  });
  const gl = new GitLabClient("https://gitlab.example.com/", "tok");
  const res = await gl.getPage("/projects/1/jobs", { page: 2, per_page: 10, scope: ["failed", "canceled"], ref: undefined });

  const [url, init] = fetchMock.mock.calls[0]!;
  const u = new URL(String(url));
  expect(u.origin + u.pathname).toBe("https://gitlab.example.com/api/v4/projects/1/jobs");
  expect(u.searchParams.getAll("scope[]")).toEqual(["failed", "canceled"]);
  expect(u.searchParams.has("ref")).toBe(false);
  expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("tok");

  expect(res.items).toEqual([{ id: 1 }]);
  expect(res.pagination).toEqual({ page: 2, per_page: 10, next_page: 3, prev_page: 1, total: 25, total_pages: 3 });
});

test("missing next page is null", async () => {
  mockFetch([], { headers: { "x-page": "1", "x-next-page": "" } });
  const res = await new GitLabClient("https://gitlab.com", "t").getPage("/projects", { page: 1, per_page: 20 });
  expect(res.pagination.next_page).toBeNull();
  expect(res.pagination.total).toBeNull();
});

test("non-2xx throws GitLabError", async () => {
  mockFetch('{"message":"404 Project Not Found"}', { status: 404 });
  const gl = new GitLabClient("https://gitlab.com", "t");
  await expect(gl.get("/projects/nope")).rejects.toBeInstanceOf(GitLabError);
});

test("cleanLog strips ANSI and section markers", () => {
  const raw =
    "\x1b[0Ksection_start:1700000000:step_script\r\x1b[0K\x1b[32;1m$ npm test\x1b[0;m\n" +
    "progress 10%\rprogress 100%\n" +
    "\x1b[31mError: boom\x1b[0m\n" +
    "section_end:1700000001:step_script\r\x1b[0K";
  expect(cleanLog(raw)).toBe("$ npm test\nprogress 100%\nError: boom\n");
});

test("tail keeps last lines with a marker", () => {
  expect(tail("a\nb\nc", 5)).toBe("a\nb\nc");
  expect(tail("a\nb\nc\nd", 2)).toBe("[... 2 lines truncated ...]\nc\nd");
});

test("unresponsive GitLab fails fast with an explicit error", async () => {
  const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  try {
    const gl = new GitLabClient(hang.url.origin, "t", 50);
    await expect(gl.get("/user")).rejects.toThrow(/GitLab unreachable at .*no response after 50ms/);
  } finally {
    hang.stop(true);
  }
});
