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
      logControl: {
        supported: boolean;
        enabled: boolean | null;
        filePath: string | null;
        applyMode: "restart_service" | "next_run" | "manual";
        serviceName: string | null;
        note: string | null;
        error: string | null;
      };
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

export type HistoryCleanupMode = "archive" | "delete" | "full_clear";

export interface HistoryCleanupResult {
  mode: HistoryCleanupMode;
  affectedFiles: number;
  archivedFiles: number;
  deletedFiles: number;
  skippedFiles: number;
  completedAt: string;
  archiveRoot: string | null;
  sources: Array<{
    id: string;
    name: string;
    affectedFiles: number;
    archivedFiles: number;
    deletedFiles: number;
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

export interface UpdateSourceLogControlResult {
  sourceId: string;
  sourceName: string;
  enabled: boolean;
  previousEnabled: boolean | null;
  message: string;
  control: {
    supported: boolean;
    enabled: boolean | null;
    filePath: string | null;
    applyMode: "restart_service" | "next_run" | "manual";
    serviceName: string | null;
    note: string | null;
    error: string | null;
  };
}
