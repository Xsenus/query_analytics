import type { LogFormat } from "../config.js";

export interface NormalizedEntry {
  id: string;
  sourceId: string;
  sourceName: string;
  format: Exclude<LogFormat, "auto">;
  filePath: string;
  fileName: string;
  timestamp: string;
  completedAt: string | null;
  unixMs: number;
  provider: string;
  operation: string;
  endpoint: string;
  method: string;
  url: string | null;
  host: string | null;
  path: string | null;
  query: string | null;
  statusCode: number | null;
  durationMs: number | null;
  result: "positive" | "negative" | "unknown";
  outcome: string;
  success: boolean | null;
  error: string | null;
  requestPreview: string | null;
  responsePreview: string | null;
  requestBody: string | null;
  responseBody: string | null;
  requestBodyComplete: boolean;
  responseBodyComplete: boolean;
  requestSize: number | null;
  responseSize: number | null;
  metaPreview: string | null;
}

export interface SourceState {
  id: string;
  name: string;
  rootPath: string;
  include: string[];
  format: LogFormat;
  discoveredFiles: number;
  totalEntries: number;
  lastEventAt: string | null;
  status: "ok" | "warning" | "missing";
  issue: string | null;
}

export interface DashboardFilters {
  fromMs: number | null;
  toMs: number | null;
  sourceIds: string[];
  provider: string | null;
  result: "positive" | "negative" | "unknown" | null;
  outcome: string | null;
  search: string | null;
  recentPage: number;
  recentPageSize: number;
}

export interface DashboardPayload {
  generatedAt: string;
  filters: {
    from: string | null;
    to: string | null;
    sourceIds: string[];
    provider: string | null;
    result: string | null;
    outcome: string | null;
    search: string | null;
    interval: "hour" | "day" | "month";
  };
  system: {
    totalIndexedRequests: number;
    totalIndexedFiles: number;
    lastRefreshAt: string | null;
    refreshIntervalMs: number;
    configPath: string;
  };
  options: {
    sources: Array<{ value: string; label: string; count: number }>;
    providers: Array<{ value: string; label: string; count: number }>;
    outcomes: Array<{ value: string; label: string; count: number }>;
  };
  summary: {
    totalRequests: number;
    positiveRequests: number;
    negativeRequests: number;
    unknownRequests: number;
    successRate: number;
    avgDurationMs: number | null;
    p95DurationMs: number | null;
    maxDurationMs: number | null;
    avgGapMs: number | null;
    p95GapMs: number | null;
    maxGapMs: number | null;
    uniqueEndpoints: number;
    uniqueProviders: number;
    latestTimestamp: string | null;
  };
  charts: {
    timeline: Array<{ bucket: string; total: number; positive: number; negative: number; unknown: number }>;
    providers: Array<{ key: string; count: number; positive: number; negative: number }>;
    sources: Array<{ key: string; count: number; positive: number; negative: number }>;
    outcomes: Array<{ key: string; count: number }>;
    statusCodes: Array<{ key: string; count: number }>;
    endpoints: Array<{
      key: string;
      count: number;
      positive: number;
      negative: number;
      avgDurationMs: number | null;
      platforms: Array<{ key: string; count: number }>;
    }>;
    hours: Array<{ key: string; total: number; positive: number; negative: number }>;
  };
  tables: {
    sourceActivity: Array<{
      id: string;
      name: string;
      status: "ok" | "warning" | "missing";
      issue: string | null;
      discoveredFiles: number;
      totalEntries: number;
      filteredEntries: number;
      lastEventAt: string | null;
    }>;
    recentRequests: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
      items: Array<{
        id: string;
        timestamp: string;
        sourceName: string;
        provider: string;
        operation: string;
        method: string;
        result: string;
        outcome: string;
        statusCode: number | null;
        durationMs: number | null;
        gapSincePreviousMs: number | null;
        error: string | null;
        url: string | null;
        requestPreview: string | null;
        responsePreview: string | null;
      }>;
    };
  };
}

export interface ArchiveHistoryResult {
  archivedFiles: number;
  skippedFiles: number;
  archivedAt: string;
  archiveRoot: string;
  sources: Array<{
    id: string;
    name: string;
    archivedFiles: number;
    skippedFiles: number;
  }>;
}

export interface RequestDetailsPayload {
  id: string;
  timestamp: string;
  sourceName: string;
  provider: string;
  operation: string;
  method: string;
  result: string;
  outcome: string;
  statusCode: number | null;
  durationMs: number | null;
  error: string | null;
  url: string | null;
  requestPreview: string | null;
  responsePreview: string | null;
  requestBody: string | null;
  responseBody: string | null;
  requestBodyComplete: boolean;
  responseBodyComplete: boolean;
}
