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

/** A string is a PAT (`PRIVATE-TOKEN`); `{ bearer }` is a user's OAuth token; null = no credentials. */
export type GitLabCredentials = string | { bearer: string } | null;

export class GitLabClient {
  private apiBase: string;
  private authHeaders: Record<string, string>;

  constructor(
    private baseUrl: string,
    credentials: GitLabCredentials,
    private timeoutMs = 20_000,
  ) {
    this.apiBase = `${baseUrl.replace(/\/+$/, "")}/api/v4`;
    if (typeof credentials === "string") this.authHeaders = { "PRIVATE-TOKEN": credentials };
    else if (credentials) this.authHeaders = { Authorization: `Bearer ${credentials.bearer}` };
    else this.authHeaders = {};
  }

  /** `requireToken: false` when GitLab calls use each user's OAuth token instead of GITLAB_TOKEN. */
  static fromEnv(env = process.env, { requireToken = true } = {}): GitLabClient {
    const token = requireToken ? env.GITLAB_TOKEN : null;
    if (requireToken && !token) throw new Error("GITLAB_TOKEN is required");
    return new GitLabClient(env.GITLAB_URL ?? "https://gitlab.com", token ?? null, Number(env.GITLAB_TIMEOUT_MS ?? 20_000));
  }

  /** Same instance and timeout, acting as the user who owns this OAuth access token. */
  asUser(oauthToken: string): GitLabClient {
    return new GitLabClient(this.baseUrl, { bearer: oauthToken }, this.timeoutMs);
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
    const url = this.url(path, query);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: this.authHeaders,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network-level failure (DNS, TLS, firewall, timeout): say so explicitly instead of hanging.
      const reason = err instanceof Error && err.name === "TimeoutError" ? `no response after ${this.timeoutMs}ms` : String(err);
      throw new Error(`GitLab unreachable at ${this.apiBase}: ${reason}`);
    }
    if (!res.ok) throw new GitLabError(res.status, path, await res.text());
    return res;
  }

  /** Checks connectivity and token at startup; returns the token's username. */
  async whoami(): Promise<string> {
    return (await this.get<{ username: string }>("/user")).username;
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
