import { expect, test } from "bun:test";
import { parseDuration, parseStep, parseTime, timeParam } from "../src/victoria.ts";
import { fmtMetric, fmtNum, formatHits, formatInstant, formatLogs, formatRange, formatTargets } from "../src/victoria-format.ts";

const NOW = 1_800_000_000;

test("parseTime: one convention for every tool", () => {
  expect(parseTime("now", NOW)).toBe(NOW);
  expect(parseTime("", NOW)).toBe(NOW);
  expect(parseTime("-12h", NOW)).toBe(NOW - 12 * 3600);
  expect(parseTime("12h", NOW)).toBe(NOW - 12 * 3600);
  expect(parseTime("+1h", NOW)).toBe(NOW + 3600);
  expect(parseTime("1700000000", NOW)).toBe(1_700_000_000);
  expect(parseTime("2026-01-01T00:00:00Z", NOW)).toBe(Date.UTC(2026, 0, 1) / 1000);
  expect(() => parseTime("yesterday", NOW)).toThrow("cannot parse time");
  expect(timeParam(undefined)).toBeUndefined();
});

test("parseDuration and parseStep", () => {
  expect(parseDuration("-30m")).toBe(-1800);
  expect(parseDuration("1.5d")).toBe(129600);
  expect(parseDuration("abc")).toBeUndefined();
  expect(parseStep("1m")).toBe(60);
  expect(parseStep("15")).toBe(15);
  expect(() => parseStep("-1m")).toThrow("cannot parse step");
  expect(() => parseStep("0")).toThrow("cannot parse step");
});

test("number and metric formatting", () => {
  expect(fmtNum("0.123456")).toBe("0.1235");
  expect(fmtNum(1234567)).toBe("1235000");
  expect(fmtNum("NaN")).toBe("NaN");
  expect(fmtNum(Infinity)).toBe("+Inf");
  expect(fmtNum(0.00001)).toBe("1.000e-05");
  expect(fmtMetric({ __name__: "up", job: "b", instance: "a" })).toBe('up{instance="a",job="b"}');
  expect(fmtMetric({})).toBe("{}");
});

test("formatInstant announces omitted series", () => {
  const sample = (i: number) => ({ metric: { __name__: "up", i: String(i) }, value: [NOW, "1"] as [number, string] });
  const text = formatInstant([sample(1), sample(2), sample(3)], 2);
  expect(text.split("\n")[0]).toBe("3 series at 2027-01-15T08:00:00Z");
  expect(text).toContain('up{i="1"} = 1');
  expect(text).toContain('1 more series omitted (raise "limit"');
  expect(formatInstant([], 5)).toContain("No data");
});

test("formatRange gives stats and subsamples, keeping the last point", () => {
  const values = Array.from({ length: 100 }, (_, i) => [NOW + i * 60, String(i)] as [number, string]);
  const text = formatRange([{ metric: { __name__: "x" }, values }], 10, 5);
  expect(text).toContain("min=0 max=99 avg=49.5 last=99 (5 of 100 points shown)");
  expect(text.trim().endsWith("99")).toBe(true);
});

test("formatTargets puts unhealthy targets first", () => {
  const text = formatTargets(
    [
      { labels: { job: "a", instance: "1" }, health: "up" },
      { labels: { job: "b", instance: "2" }, health: "down", lastError: "connection refused" },
    ],
    false,
  );
  expect(text.split("\n")).toEqual(["2 targets, 1 not up", "DOWN    b / 2  error=connection refused", "UP      a / 1"]);
  expect(formatTargets([{ health: "up" }], true)).toBe("All 1 scrape targets are up.");
});

test("formatLogs: one line per entry, ANSI and Docker noise dropped", () => {
  const text = formatLogs(
    {
      entries: [
        {
          _time: "2026-01-01T10:00:00.123456789Z",
          _msg: "\x1b[31mboom\x1b[0m\n",
          _stream: '{container="api"}',
          _stream_id: "abc",
          container_id: "deadbeef",
          "label.com.docker.compose": "x",
          level: "error",
        },
      ],
      skipped: 2,
    },
    1000,
    1,
  );
  expect(text.split("\n")).toEqual([
    '1 entries, newest first (limit 1 reached: narrow the query or time range, or raise "limit")',
    "(2 malformed line(s) skipped: the response was probably cut off)",
    "2026-01-01T10:00:00Z [api] boom | level=error",
  ]);
  expect(formatLogs({ entries: [{ _msg: "x".repeat(60) }], skipped: 0 }, 50, 10)).toContain("…(+10 chars)");
});

test("formatHits groups by total", () => {
  const text = formatHits(
    [
      { fields: { app: "a" }, timestamps: ["2026-01-01T00:00:00Z"], values: [1], total: 1 },
      { fields: { app: "b" }, timestamps: ["2026-01-01T00:00:00Z"], values: [5], total: 5 },
    ],
    "1h",
  );
  expect(text.split("\n\n")).toEqual([
    "6 hits in 2 group(s), step 1h",
    '{app="b"} total=5\n  2026-01-01T00:00:00Z  5',
    '{app="a"} total=1\n  2026-01-01T00:00:00Z  1',
  ]);
});
