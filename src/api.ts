import type { DashboardPayload, HistoryCleanupMode, HistoryCleanupResult, RequestDetailsPayload, UpdateSourceLogControlResult } from "./types";

export interface DashboardQuery {
  from?: string;
  to?: string;
  source?: string;
  provider?: string;
  result?: string;
  outcome?: string;
  search?: string;
  recentPage?: number;
  recentPageSize?: number;
}

export async function fetchDashboard(query: DashboardQuery): Promise<DashboardPayload> {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value && value !== "all") {
      params.set(key, value);
    }
  }

  const response = await fetch(`/api/dashboard?${params.toString()}`, {
    headers: {
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return (await response.json()) as DashboardPayload;
}

export async function cleanupHistory(before: string, sourceIds: string[], mode: HistoryCleanupMode): Promise<HistoryCleanupResult> {
  const response = await fetch("/api/history/cleanup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      before,
      sourceIds,
      mode,
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }

  return (await response.json()) as HistoryCleanupResult;
}

export async function fetchRequestDetails(id: string): Promise<RequestDetailsPayload> {
  const response = await fetch(`/api/requests/${encodeURIComponent(id)}`, {
    headers: {
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }

  return (await response.json()) as RequestDetailsPayload;
}

export async function updateSourceLogging(sourceId: string, enabled: boolean): Promise<UpdateSourceLogControlResult> {
  const response = await fetch(`/api/sources/${encodeURIComponent(sourceId)}/logging`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ enabled }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }

  return (await response.json()) as UpdateSourceLogControlResult;
}
