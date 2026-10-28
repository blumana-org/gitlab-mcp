/**
 * Compact text rendering of VictoriaMetrics / VictoriaLogs results. Raw JSON repeats label sets and
 * bookkeeping fields on every row; these keep output small and bounded, and always announce truncation.
 * Adapted from https://github.com/Plawn/victoriametrics-mcp (MIT).
 */
import type { FieldValue, HitsGroup, LogsResult } from "./victorialogs.ts";
import type { InstantSample, RangeSample, Target } from "./victoriametrics.ts";
import { truncate } from "./victoria.ts";

/** 4 significant digits, trailing zeros dropped. */
export function fmtNum(raw: string | number): string {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (Number.isNaN(value)) return String(raw);
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e15 || magnitude < 1e-4) return value.toExponential(3).replace(/e([+-])(\d)$/, "e$10$2");
  return String(Number(value.toPrecision(4)));
}

/** Epoch seconds → `2026-08-13T10:30:00Z`. */
export const fmtTime = (epochSeconds: number) => `${new Date(epochSeconds * 1000).toISOString().slice(0, 19)}Z`;

/** RFC3339 with any precision (VictoriaLogs uses nanoseconds) → second precision. */
const fmtIsoTime = (iso: string | undefined) => (iso ? `${iso.slice(0, 19).replace(" ", "T")}Z` : "?");

/** `metric{a="1",b="2"}`, labels sorted: the shape a user would write. */
export function fmtMetric(metric: Record<string, string>): string {
  const { __name__: name, ...labels } = metric;
  const entries = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return entries.length ? `${name ?? ""}{${entries.join(",")}}` : (name ?? "{}");
}

const overflow = (total: number, shown: number, unit: string, param = "limit") =>
  total > shown ? [`… ${total - shown} more ${unit} omitted (raise "${param}" to see them)`] : [];

export function formatInstant(result: InstantSample[], limit: number): string {
  if (result.length === 0) return "No data: the query matched no series.";
  const shown = result.slice(0, limit);
  const at = shown[0]?.value[0];
  return [
    `${result.length} series${at !== undefined ? ` at ${fmtTime(at)}` : ""}`,
    ...shown.map((s) => `${fmtMetric(s.metric)} = ${fmtNum(s.value[1])}`),
    ...overflow(result.length, shown.length, "series"),
  ].join("\n");
}

/** Evenly spaced subsample that always keeps the last point. */
function subsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const stride = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * stride)]!);
}

/** Per series: min/max/avg/last, then points subsampled down to `maxPoints`. */
export function formatRange(result: RangeSample[], maxSeries: number, maxPoints: number): string {
  if (result.length === 0) return "No data: the query matched no series.";
  const shown = result.slice(0, maxSeries);
  const blocks = shown.map((series) => {
    const points = series.values;
    if (points.length === 0) return `${fmtMetric(series.metric)}: no points`;
    const numbers = points.map(([, v]) => Number(v)).filter(Number.isFinite);
    const stats = numbers.length
      ? `min=${fmtNum(Math.min(...numbers))} max=${fmtNum(Math.max(...numbers))} ` +
        `avg=${fmtNum(numbers.reduce((a, b) => a + b, 0) / numbers.length)} last=${fmtNum(numbers.at(-1)!)}`
      : "no numeric points";
    const sampled = subsample(points, maxPoints);
    const note = points.length > sampled.length ? ` (${sampled.length} of ${points.length} points shown)` : ` (${points.length} points)`;
    const lines = sampled.map(([t, v]) => `  ${fmtTime(t)}  ${fmtNum(v)}`).join("\n");
    return `${fmtMetric(series.metric)}\n  ${stats}${note}\n${lines}`;
  });
  return [`${result.length} series`, ...blocks, ...overflow(result.length, shown.length, "series", "max_series")].join("\n\n");
}

export function formatSeries(result: Record<string, string>[], limit: number): string {
  if (result.length === 0) return "No series matched.";
  const shown = result.slice(0, limit);
  return [`${result.length} series`, ...shown.map(fmtMetric), ...overflow(result.length, shown.length, "series")].join("\n");
}

export function formatLabelValues(label: string, values: string[], limit: number): string {
  if (values.length === 0) return `No values found for label "${label}".`;
  const shown = values.slice(0, limit);
  return [`${values.length} values for "${label}"`, ...shown.map((v) => `  ${v}`), ...overflow(values.length, shown.length, "values")].join(
    "\n",
  );
}

/** Only job / instance / health / last error: the raw endpoint returns every discovered label. */
export function formatTargets(targets: Target[], onlyUnhealthy: boolean): string {
  const rows = targets.map((t) => {
    const labels = { ...t.discoveredLabels, ...t.labels };
    return {
      job: labels.job ?? t.scrapePool ?? "?",
      instance: labels.instance ?? "?",
      health: (t.health ?? "unknown").toLowerCase(),
      lastError: t.lastError?.trim() ?? "",
    };
  });
  if (rows.length === 0) return "No scrape targets configured.";
  const unhealthy = rows.filter((r) => r.health !== "up");
  const selected = onlyUnhealthy ? unhealthy : rows;
  if (selected.length === 0) return `All ${rows.length} scrape targets are up.`;
  selected.sort(
    (a, b) => Number(a.health === "up") - Number(b.health === "up") || a.job.localeCompare(b.job) || a.instance.localeCompare(b.instance),
  );
  const lines = selected.map(
    (r) => `${r.health.toUpperCase().padEnd(7)} ${r.job} / ${r.instance}${r.lastError ? `  error=${truncate(r.lastError, 200)}` : ""}`,
  );
  return [`${rows.length} targets, ${unhealthy.length} not up`, ...lines].join("\n");
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** VictoriaLogs / Docker / Vector bookkeeping: container ids and labels otherwise dwarf the message on every line. */
const NOISE_FIELDS = new Set([
  "_stream_id", "_time", "_msg", "_stream", "container", "container_id", "container_name",
  "container_created_at", "host", "hostname", "image", "stream", "source_type", "timestamp",
]);
const isNoise = (key: string) => NOISE_FIELDS.has(key) || key.startsWith("label.") || key.startsWith("com.docker.");

/** One line per entry: time, source, message (ANSI stripped), then the remaining structured fields. */
export function formatLogs({ entries, skipped }: LogsResult, maxMessageChars: number, limit: number): string {
  const notes = skipped ? [`(${skipped} malformed line(s) skipped: the response was probably cut off)`] : [];
  if (entries.length === 0) return ["No log entries matched.", ...notes].join("\n");
  const lines = entries.map((row) => {
    const container = /container="([^"]+)"/.exec(row._stream ?? "")?.[1];
    const source = container ?? row.container ?? row.host ?? "";
    const message = String(row._msg ?? "").replace(ANSI_RE, "").replace(/\s+$/, "");
    const extras = Object.entries(row)
      .filter(([k, v]) => !isNoise(k) && v !== "")
      .map(([k, v]) => `${k}=${truncate(String(v), 80)}`)
      .join(" ");
    return [fmtIsoTime(row._time), source && `[${source}]`, truncate(message, maxMessageChars), extras && `| ${truncate(extras, 160)}`]
      .filter(Boolean)
      .join(" ");
  });
  const header = `${entries.length} entries, newest first${entries.length >= limit ? ` (limit ${limit} reached: narrow the query or time range, or raise "limit")` : ""}`;
  return [header, ...notes, ...lines].join("\n");
}

/** Per group: its fields, total, then one `time count` line per non-empty bucket. */
export function formatHits(groups: HitsGroup[], stepLabel: string): string {
  if (groups.length === 0) return "No log entries matched.";
  const total = groups.reduce((sum, g) => sum + (g.total ?? 0), 0);
  const blocks = groups
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
    .map((g) => {
      const name = g.fields && Object.keys(g.fields).length ? fmtMetric(g.fields) : "all";
      const buckets = (g.timestamps ?? []).map((t, i) => `  ${fmtIsoTime(t)}  ${g.values?.[i] ?? 0}`);
      return [`${name} total=${g.total ?? 0}`, ...buckets].join("\n");
    });
  return [`${total} hits in ${groups.length} group(s), step ${stepLabel}`, ...blocks].join("\n\n");
}

export function formatFieldValues(what: string, values: FieldValue[], limit?: number): string {
  if (values.length === 0) return `No ${what} found.`;
  const shown = limit ? values.slice(0, limit) : values;
  return [
    `${values.length} ${what} (hits)`,
    ...shown.map((v) => `  ${v.value === "" ? '""' : v.value} (${v.hits})`),
    ...(limit && values.length >= limit ? [`(limit ${limit} reached: raise "limit" to see more)`] : []),
  ].join("\n");
}
