import { VictoriaHttpClient, parseStep, timeParam, victoriaEnv } from "./victoria.ts";

export type LogEntry = Record<string, string>;

export interface TimeRange {
  /** Anything `parseTime` accepts. */
  start?: string;
  end?: string;
}

export interface FieldValue {
  value: string;
  hits: number;
}

export interface HitsGroup {
  fields?: Record<string, string>;
  timestamps?: string[];
  values?: number[];
  total?: number;
}

export interface LogsResult {
  entries: LogEntry[];
  /** Unparseable lines, e.g. a stream cut off by a timeout. */
  skipped: number;
}

/** Read-only client for the VictoriaLogs LogsQL HTTP API, possibly behind an oauth2-proxy. */
export class VictoriaLogsClient extends VictoriaHttpClient {
  constructor(baseUrl: string, bearer: string | null, timeoutMs = 20_000) {
    super("VictoriaLogs", baseUrl, bearer, timeoutMs);
  }

  /** null when VICTORIALOGS_URL is unset: the VictoriaLogs tools are then not registered. */
  static fromEnv(env = process.env): VictoriaLogsClient | null {
    const cfg = victoriaEnv("VICTORIALOGS", env);
    return cfg && new VictoriaLogsClient(cfg.baseUrl, cfg.bearer, cfg.timeoutMs);
  }

  /** Same instance, authenticated as the user who owns this (already verified) realm token. */
  asUser(token: string): VictoriaLogsClient {
    return new VictoriaLogsClient(this.baseUrl, token, this.timeoutMs);
  }

  /** Matching log entries, newest first. */
  async query({ query, start, end, limit }: TimeRange & { query: string; limit: number }): Promise<LogsResult> {
    const res = await this.post("/select/logsql/query", { query, start: timeParam(start), end: timeParam(end), limit });
    const result = parseNdjson(await res.text());
    result.entries.sort((a, b) => String(b._time ?? "").localeCompare(String(a._time ?? "")));
    return result;
  }

  /** Number of matching entries per `step` bucket, optionally grouped by `field`. */
  async hits({ query, start, end, step, field }: TimeRange & { query: string; step: string; field?: string }): Promise<HitsGroup[]> {
    const res = await this.post("/select/logsql/hits", {
      query,
      start: timeParam(start),
      end: timeParam(end),
      step: `${parseStep(step)}s`,
      field,
    });
    return ((await res.json()) as { hits?: HitsGroup[] }).hits ?? [];
  }

  async fieldNames({ query, start, end }: TimeRange & { query: string }): Promise<FieldValue[]> {
    const res = await this.post("/select/logsql/field_names", { query, start: timeParam(start), end: timeParam(end) });
    return ((await res.json()) as { values?: FieldValue[] }).values ?? [];
  }

  async fieldValues({ query, field, start, end, limit }: TimeRange & { query: string; field: string; limit: number }): Promise<FieldValue[]> {
    const res = await this.post("/select/logsql/field_values", { query, field, start: timeParam(start), end: timeParam(end), limit });
    return ((await res.json()) as { values?: FieldValue[] }).values ?? [];
  }
}

/** VictoriaLogs streams one JSON object per line. Bad lines (truncated stream) are skipped, not fatal. */
export function parseNdjson(body: string): LogsResult {
  const result: LogsResult = { entries: [], skipped: 0 };
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      result.entries.push(JSON.parse(line) as LogEntry);
    } catch {
      result.skipped++;
    }
  }
  return result;
}
