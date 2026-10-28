import { VictoriaError, VictoriaHttpClient, parseStep, parseTime, timeParam, victoriaEnv, type Params } from "./victoria.ts";

export interface InstantSample {
  metric: Record<string, string>;
  value: [number, string];
}

export interface RangeSample {
  metric: Record<string, string>;
  values: [number, string][];
}

export interface Target {
  scrapePool?: string;
  labels?: Record<string, string>;
  discoveredLabels?: Record<string, string>;
  health?: string;
  lastError?: string;
}

export type InstantResult =
  | { resultType: "vector" | "matrix"; result: InstantSample[] }
  | { resultType: "scalar" | "string"; result: unknown };

/** Read-only client for the Prometheus-compatible API of VictoriaMetrics (or Prometheus), possibly behind an oauth2-proxy. */
export class VictoriaMetricsClient extends VictoriaHttpClient {
  constructor(baseUrl: string, bearer: string | null, timeoutMs = 20_000) {
    super("VictoriaMetrics", baseUrl, bearer, timeoutMs);
  }

  /** null when VICTORIAMETRICS_URL is unset: the metrics tools are then not registered. */
  static fromEnv(env = process.env): VictoriaMetricsClient | null {
    const cfg = victoriaEnv("VICTORIAMETRICS", env);
    return cfg && new VictoriaMetricsClient(cfg.baseUrl, cfg.bearer, cfg.timeoutMs);
  }

  /** Same instance, authenticated as the user who owns this (already verified) realm token. */
  asUser(token: string): VictoriaMetricsClient {
    return new VictoriaMetricsClient(this.baseUrl, token, this.timeoutMs);
  }

  /** Calls a Prometheus-style endpoint and unwraps its `data` field. */
  private async api<T>(path: string, params: Params): Promise<T> {
    const payload = (await (await this.post(path, params)).json()) as { status?: string; data?: T; error?: string; errorType?: string };
    if (payload.status === "error") {
      throw new VictoriaError(`VictoriaMetrics error${payload.errorType ? ` (${payload.errorType})` : ""}: ${payload.error ?? "unknown"}`);
    }
    if (payload.data === undefined) throw new VictoriaError(`unexpected response from ${path}: no data field`);
    return payload.data;
  }

  query(query: string, time?: string): Promise<InstantResult> {
    return this.api("/api/v1/query", { query, time: timeParam(time) });
  }

  /** Without `step`, picks one giving ~60 points so an open range never asks for a huge matrix. */
  async queryRange({ query, start, end, step }: { query: string; start: string; end: string; step?: string }) {
    const startTs = parseTime(start);
    const endTs = parseTime(end);
    if (endTs <= startTs) throw new VictoriaError(`empty range: start (${start}) must be before end (${end})`);
    const stepSeconds = step ? parseStep(step) : Math.max(1, Math.floor((endTs - startTs) / 60));
    const data = await this.api<{ result: RangeSample[] }>("/api/v1/query_range", {
      query,
      start: startTs,
      end: endTs,
      step: `${stepSeconds}s`,
    });
    return { result: data.result, stepSeconds };
  }

  series({ match, start, end }: { match: string[]; start?: string; end?: string }): Promise<Record<string, string>[]> {
    return this.api("/api/v1/series", { "match[]": match, start: timeParam(start), end: timeParam(end) });
  }

  labelValues({ label, match, start, end }: { label: string; match?: string[]; start?: string; end?: string }): Promise<string[]> {
    return this.api(`/api/v1/label/${encodeURIComponent(label)}/values`, {
      "match[]": match,
      start: timeParam(start),
      end: timeParam(end),
    });
  }

  async targets(): Promise<Target[]> {
    return (await this.api<{ activeTargets?: Target[] }>("/api/v1/targets", { state: "active" })).activeTargets ?? [];
  }
}
