export type ProjectRef = string | number;

export interface Pagination {
  page: number;
  per_page: number;
  next_page: number | null;
  prev_page: number | null;
  total: number | null;
  total_pages: number | null;
}

export interface Page<T> {
  items: T[];
  pagination: Pagination;
}

export class GitLabError extends Error {
  constructor(
    public status: number,
    public path: string,
    body: string,
  ) {
    super(`GitLab API ${status} on ${path}: ${body.slice(0, 500)}`);
  }
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export class GitLabClient {
  private apiBase: string;

  constructor(
    baseUrl: string,
    private token: string,
  ) {
    this.apiBase = `${baseUrl.replace(/\/+$/, "")}/api/v4`;
  }

  static fromEnv(env = process.env): GitLabClient {
    const token = env.GITLAB_TOKEN;
    if (!token) throw new Error("GITLAB_TOKEN is required");
    return new GitLabClient(env.GITLAB_URL ?? "https://gitlab.com", token);
  }

  private url(path: string, query: Query = {}): string {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === "") continue;
      // Arrays use Rails-style `key[]=a&key[]=b`.
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(`${k}[]`, item);
      else url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async request(path: string, query?: Query): Promise<Response> {
    const res = await fetch(this.url(path, query), {
      headers: { "PRIVATE-TOKEN": this.token },
    });
    if (!res.ok) throw new GitLabError(res.status, path, await res.text());
    return res;
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    return (await this.request(path, query)).json() as Promise<T>;
  }

  async getText(path: string, query?: Query): Promise<string> {
    return (await this.request(path, query)).text();
  }

  async getPage<T>(path: string, query: Query = {}): Promise<Page<T>> {
    const res = await this.request(path, query);
    const items = (await res.json()) as T[];
    return { items, pagination: parsePagination(res.headers, query) };
  }
}

const num = (v: string | null): number | null => (v ? Number(v) : null);

export function parsePagination(headers: Headers, query: Query): Pagination {
  return {
    page: num(headers.get("x-page")) ?? Number(query.page ?? 1),
    per_page: num(headers.get("x-per-page")) ?? Number(query.per_page ?? 20),
    next_page: num(headers.get("x-next-page")),
    prev_page: num(headers.get("x-prev-page")),
    // GitLab omits totals on very large collections.
    total: num(headers.get("x-total")),
    total_pages: num(headers.get("x-total-pages")),
  };
}

export const projectPath = (project: ProjectRef) =>
  `/projects/${encodeURIComponent(String(project))}`;

// Strips ANSI colors and GitLab collapsible section markers from job traces.
export function cleanLog(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/section_(start|end):\d+:[^\r\n]*?\r(\x1b\[0K)?/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

export function tail(text: string, lines: number): string {
  const all = text.split("\n");
  if (all.length <= lines) return text;
  return `[... ${all.length - lines} lines truncated ...]\n` + all.slice(-lines).join("\n");
}
