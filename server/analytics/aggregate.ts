import type { RuntimeConfig } from "../config.js";
import type { DashboardFilters, DashboardPayload, NormalizedEntry, SourceState } from "./types.js";

function countMap(entries: NormalizedEntry[], keyFn: (entry: NormalizedEntry) => string | null) {
  const map = new Map<string, number>();

  for (const entry of entries) {
    const key = keyFn(entry);
    if (!key) {
      continue;
    }

    map.set(key, (map.get(key) ?? 0) + 1);
  }

  return map;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildBucket(timestamp: string, interval: "hour" | "day" | "month"): string {
  if (interval === "month") {
    return timestamp.slice(0, 7);
  }

  if (interval === "day") {
    return timestamp.slice(0, 10);
  }

  return `${timestamp.slice(0, 13)}:00`;
}

function chooseInterval(fromMs: number | null, toMs: number | null): "hour" | "day" | "month" {
  if (fromMs === null || toMs === null) {
    return "day";
  }

  const diff = Math.max(toMs - fromMs, 0);
  if (diff <= 1000 * 60 * 60 * 48) {
    return "hour";
  }

  if (diff <= 1000 * 60 * 60 * 24 * 120) {
    return "day";
  }

  return "month";
}

function percentile(values: number[], target: number): number | null {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(target * sorted.length) - 1));
  return round(sorted[index]);
}

function filterEntries(entries: NormalizedEntry[], filters: DashboardFilters): NormalizedEntry[] {
  const search = filters.search?.toLowerCase();

  return entries.filter((entry) => {
    if (filters.fromMs !== null && entry.unixMs < filters.fromMs) {
      return false;
    }

    if (filters.toMs !== null && entry.unixMs > filters.toMs) {
      return false;
    }

    if (filters.sourceIds.length > 0 && !filters.sourceIds.includes(entry.sourceId)) {
      return false;
    }

    if (filters.provider && entry.provider !== filters.provider) {
      return false;
    }

    if (filters.result && entry.result !== filters.result) {
      return false;
    }

    if (filters.outcome && entry.outcome !== filters.outcome) {
      return false;
    }

    if (search) {
      const haystack = [
        entry.sourceName,
        entry.provider,
        entry.operation,
        entry.endpoint,
        entry.url ?? "",
        entry.error ?? "",
        entry.requestPreview ?? "",
        entry.responsePreview ?? "",
      ]
        .join(" ")
        .toLowerCase();

      if (!haystack.includes(search)) {
        return false;
      }
    }

    return true;
  });
}

export function buildDashboardPayload(
  entries: NormalizedEntry[],
  sourceStates: SourceState[],
  filters: DashboardFilters,
  runtime: RuntimeConfig,
  lastRefreshAt: string | null,
): DashboardPayload {
  const filteredEntries = filterEntries(entries, filters);
  const interval = chooseInterval(filters.fromMs, filters.toMs);
  const durations = filteredEntries
    .map((entry) => entry.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const timeline = new Map<string, { total: number; positive: number; negative: number; unknown: number }>();
  const providerMap = new Map<string, { count: number; positive: number; negative: number }>();
  const sourceMap = new Map<string, { count: number; positive: number; negative: number }>();
  const endpointMap = new Map<string, { count: number; positive: number; negative: number; durationTotal: number; durationCount: number }>();
  const hourMap = new Map<string, { total: number; positive: number; negative: number }>();

  for (let hour = 0; hour < 24; hour += 1) {
    hourMap.set(String(hour).padStart(2, "0"), { total: 0, positive: 0, negative: 0 });
  }

  for (const entry of filteredEntries) {
    const bucket = buildBucket(entry.timestamp, interval);
    const timelineRow = timeline.get(bucket) ?? { total: 0, positive: 0, negative: 0, unknown: 0 };
    timelineRow.total += 1;
    timelineRow[entry.result] += 1;
    timeline.set(bucket, timelineRow);

    const providerRow = providerMap.get(entry.provider) ?? { count: 0, positive: 0, negative: 0 };
    providerRow.count += 1;
    if (entry.result === "positive") {
      providerRow.positive += 1;
    }
    if (entry.result === "negative") {
      providerRow.negative += 1;
    }
    providerMap.set(entry.provider, providerRow);

    const sourceRow = sourceMap.get(entry.sourceId) ?? { count: 0, positive: 0, negative: 0 };
    sourceRow.count += 1;
    if (entry.result === "positive") {
      sourceRow.positive += 1;
    }
    if (entry.result === "negative") {
      sourceRow.negative += 1;
    }
    sourceMap.set(entry.sourceId, sourceRow);

    const endpointRow = endpointMap.get(entry.endpoint) ?? {
      count: 0,
      positive: 0,
      negative: 0,
      durationTotal: 0,
      durationCount: 0,
    };
    endpointRow.count += 1;
    if (entry.result === "positive") {
      endpointRow.positive += 1;
    }
    if (entry.result === "negative") {
      endpointRow.negative += 1;
    }
    if (typeof entry.durationMs === "number") {
      endpointRow.durationTotal += entry.durationMs;
      endpointRow.durationCount += 1;
    }
    endpointMap.set(entry.endpoint, endpointRow);

    const hourKey = entry.timestamp.slice(11, 13);
    const hourRow = hourMap.get(hourKey);
    if (hourRow) {
      hourRow.total += 1;
      if (entry.result === "positive") {
        hourRow.positive += 1;
      }
      if (entry.result === "negative") {
        hourRow.negative += 1;
      }
    }
  }

  const positiveRequests = filteredEntries.filter((entry) => entry.result === "positive").length;
  const negativeRequests = filteredEntries.filter((entry) => entry.result === "negative").length;
  const unknownRequests = filteredEntries.filter((entry) => entry.result === "unknown").length;
  const pageSize = Math.max(1, Math.min(filters.recentPageSize, runtime.maxRecentRequests));
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / pageSize));
  const page = Math.max(1, Math.min(filters.recentPage, totalPages));
  const pageStart = (page - 1) * pageSize;
  const recentItems = filteredEntries.slice(pageStart, pageStart + pageSize);

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      from: filters.fromMs === null ? null : new Date(filters.fromMs).toISOString(),
      to: filters.toMs === null ? null : new Date(filters.toMs).toISOString(),
      sourceIds: filters.sourceIds,
      provider: filters.provider,
      result: filters.result,
      outcome: filters.outcome,
      search: filters.search,
      interval,
    },
    system: {
      totalIndexedRequests: entries.length,
      totalIndexedFiles: sourceStates.reduce((sum, source) => sum + source.discoveredFiles, 0),
      lastRefreshAt,
      refreshIntervalMs: runtime.refreshIntervalMs,
      configPath: runtime.sourcesConfigPath,
    },
    options: {
      sources: sourceStates.map((source) => ({
        value: source.id,
        label: source.name,
        count: source.totalEntries,
      })),
      providers: [...countMap(entries, (entry) => entry.provider).entries()]
        .map(([value, count]) => ({ value, label: value, count }))
        .sort((left, right) => right.count - left.count),
      outcomes: [...countMap(entries, (entry) => entry.outcome).entries()]
        .map(([value, count]) => ({ value, label: value, count }))
        .sort((left, right) => right.count - left.count),
    },
    summary: {
      totalRequests: filteredEntries.length,
      positiveRequests,
      negativeRequests,
      unknownRequests,
      successRate: filteredEntries.length === 0 ? 0 : round((positiveRequests / filteredEntries.length) * 100),
      avgDurationMs: durations.length === 0 ? null : round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      p95DurationMs: percentile(durations, 0.95),
      maxDurationMs: durations.length === 0 ? null : round(Math.max(...durations)),
      uniqueEndpoints: new Set(filteredEntries.map((entry) => entry.endpoint)).size,
      uniqueProviders: new Set(filteredEntries.map((entry) => entry.provider)).size,
      latestTimestamp: filteredEntries[0]?.timestamp ?? null,
    },
    charts: {
      timeline: [...timeline.entries()]
        .map(([bucket, values]) => ({ bucket, ...values }))
        .sort((left, right) => left.bucket.localeCompare(right.bucket)),
      providers: [...providerMap.entries()]
        .map(([key, values]) => ({ key, ...values }))
        .sort((left, right) => right.count - left.count),
      sources: sourceStates
        .map((source) => ({
          key: source.name,
          count: sourceMap.get(source.id)?.count ?? 0,
          positive: sourceMap.get(source.id)?.positive ?? 0,
          negative: sourceMap.get(source.id)?.negative ?? 0,
        }))
        .sort((left, right) => right.count - left.count),
      outcomes: [...countMap(filteredEntries, (entry) => entry.outcome).entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((left, right) => right.count - left.count),
      statusCodes: [...countMap(filteredEntries, (entry) => (entry.statusCode === null ? null : String(entry.statusCode))).entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((left, right) => Number(left.key) - Number(right.key)),
      endpoints: [...endpointMap.entries()]
        .map(([key, values]) => ({
          key,
          count: values.count,
          positive: values.positive,
          negative: values.negative,
          avgDurationMs: values.durationCount === 0 ? null : round(values.durationTotal / values.durationCount),
        }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 12),
      hours: [...hourMap.entries()].map(([key, values]) => ({ key, ...values })),
    },
    tables: {
      sourceActivity: sourceStates.map((source) => ({
        id: source.id,
        name: source.name,
        status: source.status,
        issue: source.issue,
        discoveredFiles: source.discoveredFiles,
        totalEntries: source.totalEntries,
        filteredEntries: sourceMap.get(source.id)?.count ?? 0,
        lastEventAt: source.lastEventAt,
      })),
      recentRequests: {
        page,
        pageSize,
        total: filteredEntries.length,
        totalPages,
        items: recentItems.map((entry) => ({
          id: entry.id,
          timestamp: entry.timestamp,
          sourceName: entry.sourceName,
          provider: entry.provider,
          operation: entry.operation,
          method: entry.method,
          result: entry.result,
          outcome: entry.outcome,
          statusCode: entry.statusCode,
          durationMs: entry.durationMs,
          error: entry.error,
          url: entry.url,
          requestPreview: entry.requestPreview,
          responsePreview: entry.responsePreview,
        })),
      },
    },
  };
}
