/**
 * Shared plumbing for VictoriaMetrics and VictoriaLogs: authenticated POST (often through an oauth2-proxy),
 * readable errors, and the time/step parsing used by every tool.
 */

export type Params = Record<string, string | number | string[] | undefined>;

/** A bad query or an unexpected answer, with a message the model can act on. */
export class VictoriaError extends Error {}

export interface VictoriaEnv {
  baseUrl: string;
  bearer: string | null;
  timeoutMs: number;
}

/**
 * Reads `<PREFIX>_URL`, `<PREFIX>_TOKEN`, `<PREFIX>_TIMEOUT_MS`; null when the URL is unset (backend disabled).
 * The timeout falls back to GITLAB_TIMEOUT_MS, then 20s.
 */
export function victoriaEnv(prefix: string, env: Record<string, string | undefined>): VictoriaEnv | null {
  const baseUrl = env[`${prefix}_URL`];
  if (!baseUrl) return null;
  return {
    baseUrl,
    bearer: env[`${prefix}_TOKEN`] || null,
    timeoutMs: Number(env[`${prefix}_TIMEOUT_MS`] ?? env.GITLAB_TIMEOUT_MS ?? 20_000),
  };
}

export abstract class VictoriaHttpClient {
  readonly baseUrl: string;

  constructor(
    /** Product name used in error messages. */
    private label: string,
    baseUrl: string,
    /** Sent as `Authorization: Bearer`; null = no credentials (e.g. internal URL without proxy). */
    readonly bearer: string | null,
    protected timeoutMs = 20_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Form-encoded POST: long queries are never capped by URL length limits. */
  protected async post(path: string, params: Params): Promise<Response> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item));
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {}),
        },
        body,
        // oauth2-proxy redirects unauthenticated requests to its login page: report it instead of following.
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? `no response after ${this.timeoutMs}ms` : String(err);
      throw new Error(`${this.label} unreachable at ${this.baseUrl}: ${reason}`);
    }
    if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
      throw new Error(
        `${this.label} (oauth2-proxy) rejected the ${this.bearer ? "token" : "anonymous request"} with HTTP ${res.status}: ` +
          "check --skip-jwt-bearer-tokens, --extra-jwt-issuers (issuer=audience) and the token's aud/email claims",
      );
    }
    if (!res.ok) throw new VictoriaError(`${this.label} ${res.status} on ${path}: ${errorDetail(await res.text())}`);
    return res;
  }
}

/** Both backends report query errors as JSON `{ error }` (VictoriaMetrics) or plain text (VictoriaLogs). */
function errorDetail(body: string): string {
  body = body.trim();
  try {
    const { error } = JSON.parse(body) as { error?: string };
    if (error) return truncate(error, 500);
  } catch {
    // Not JSON: keep the raw body.
  }
  return truncate(body, 500);
}

const DURATION_RE = /^([+-]?)(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)$/;
const DURATION_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };

/** `12h` or `-30m` in seconds, sign preserved; undefined if not a duration. */
export function parseDuration(text: string): number | undefined {
  const match = DURATION_RE.exec(text.trim());
  if (!match) return undefined;
  const [, sign, amount, unit] = match;
  const seconds = Number(amount) * DURATION_SECONDS[unit!]!;
  return sign === "-" ? -seconds : seconds;
}

export const TIME_HINT =
  'Accepts "now", a duration ago such as "-12h" or "30m" ("+1h" for the future), an epoch in seconds, or an RFC3339 timestamp.';

/**
 * A user-supplied instant as epoch seconds. Durations count back from now whether or not they carry a `-`
 * (`1h` = an hour ago, as in "the last hour"); `+1h` is in the future.
 */
export function parseTime(text: string, now = Date.now() / 1000): number {
  const value = text.trim();
  if (!value || value === "now") return Math.floor(now);
  const duration = parseDuration(value);
  if (duration !== undefined) return Math.floor(value.startsWith("+") ? now + duration : now - Math.abs(duration));
  if (/^\d+(\.\d+)?$/.test(value)) return Math.floor(Number(value));
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  throw new VictoriaError(`cannot parse time ${JSON.stringify(text)}; ${TIME_HINT}`);
}

/** `parseTime` for optional arguments, as the epoch string both APIs accept. */
export const timeParam = (text: string | undefined) => (text === undefined ? undefined : String(parseTime(text)));

/** A step such as `1m`, or bare seconds. */
export function parseStep(text: string): number {
  const seconds = parseDuration(text);
  if (seconds !== undefined && seconds > 0) return seconds;
  if (/^\d+(\.\d+)?$/.test(text.trim()) && Number(text) > 0) return Number(text);
  throw new VictoriaError(`cannot parse step ${JSON.stringify(text)}; use a duration like "30s", "1m" or "1h"`);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max} chars)`;
}
