import fs from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import { loadSourcesConfig, type RuntimeConfig } from "../config.js";
import { buildDashboardPayload } from "./aggregate.js";
import { parseLogContent } from "./parser.js";
import type { ArchiveHistoryResult, DashboardFilters, DashboardPayload, NormalizedEntry, RequestDetailsPayload, SourceState } from "./types.js";

interface CachedFile {
  size: number;
  mtimeMs: number;
  entries: NormalizedEntry[];
  parseErrors: number;
}

export class AnalyticsIndexer {
  private cache = new Map<string, CachedFile>();
  private entries: NormalizedEntry[] = [];
  private sourceStates: SourceState[] = [];
  private lastRefreshAt: string | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly runtime: RuntimeConfig) {}

  async getDashboard(filters: DashboardFilters, forceRefresh = false): Promise<DashboardPayload> {
    await this.ensureFresh(forceRefresh);
    return buildDashboardPayload(this.entries, this.sourceStates, filters, this.runtime, this.lastRefreshAt);
  }

  async getHealth(forceRefresh = false) {
    await this.ensureFresh(forceRefresh);
    return {
      status: "ok",
      indexedRequests: this.entries.length,
      indexedFiles: this.cache.size,
      lastRefreshAt: this.lastRefreshAt,
      sources: this.sourceStates,
    };
  }

  async getRequestDetails(id: string, forceRefresh = false): Promise<RequestDetailsPayload | null> {
    await this.ensureFresh(forceRefresh);
    const entry = this.entries.find((item) => item.id === id);

    if (!entry) {
      return null;
    }

    return {
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
      requestBody: entry.requestBody,
      responseBody: entry.responseBody,
      requestBodyComplete: entry.requestBodyComplete,
      responseBodyComplete: entry.responseBodyComplete,
    };
  }

  async archiveHistory(sourceIds: string[], beforeMs: number): Promise<ArchiveHistoryResult> {
    const sources = loadSourcesConfig(this.runtime.sourcesConfigPath);
    const selectedSources = sourceIds.length > 0 ? sources.filter((source) => sourceIds.includes(source.id)) : sources;
    const archiveStamp = new Date().toISOString().replaceAll(":", "-");
    const archiveRoot = ".query-analytics-archive";
    const todayIso = new Date().toISOString().slice(0, 10);
    const beforeIso = new Date(beforeMs).toISOString().slice(0, 10);
    const protectedMtimeMs = Date.now() - 10 * 60 * 1000;
    const result: ArchiveHistoryResult = {
      archivedFiles: 0,
      skippedFiles: 0,
      archivedAt: new Date().toISOString(),
      archiveRoot,
      sources: [],
    };

    for (const source of selectedSources) {
      const matchedFiles = await this.getMatchedFiles(source.rootPath, source.include);
      let archivedFiles = 0;
      let skippedFiles = 0;

      for (const filePath of matchedFiles) {
        const fileStat = await fs.stat(filePath);
        const dateMatch = path.basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
        const fileDate = dateMatch?.[1] ?? new Date(fileStat.mtimeMs).toISOString().slice(0, 10);

        const isToday = fileDate >= todayIso;
        const isBeforeCutoff = fileDate <= beforeIso;
        const isRecentlyModified = fileStat.mtimeMs >= protectedMtimeMs;

        if (!isBeforeCutoff || isToday || isRecentlyModified) {
          skippedFiles += 1;
          continue;
        }

        const relativePath = path.relative(source.rootPath, filePath);
        const archiveTarget = path.join(source.rootPath, archiveRoot, archiveStamp, relativePath);
        await fs.mkdir(path.dirname(archiveTarget), { recursive: true });
        await fs.rename(filePath, archiveTarget);
        archivedFiles += 1;
      }

      result.archivedFiles += archivedFiles;
      result.skippedFiles += skippedFiles;
      result.sources.push({
        id: source.id,
        name: source.name,
        archivedFiles,
        skippedFiles,
      });
    }

    await this.refresh();
    return result;
  }

  private async ensureFresh(forceRefresh: boolean): Promise<void> {
    const isFresh =
      !forceRefresh &&
      this.lastRefreshAt !== null &&
      Date.now() - Date.parse(this.lastRefreshAt) < this.runtime.refreshIntervalMs;

    if (isFresh) {
      return;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }

    await this.refreshPromise;
  }

  private async refresh(): Promise<void> {
    const sources = loadSourcesConfig(this.runtime.sourcesConfigPath);
    const nextCache = new Map<string, CachedFile>();
    const nextSourceStates: SourceState[] = [];

    for (const source of sources) {
      const state: SourceState = {
        id: source.id,
        name: source.name,
        rootPath: source.rootPath,
        include: source.include,
        format: source.format ?? "auto",
        discoveredFiles: 0,
        totalEntries: 0,
        lastEventAt: null,
        status: "ok",
        issue: null,
      };

      try {
        await fs.access(source.rootPath);
      } catch {
        state.status = "missing";
        state.issue = "Каталог источника не найден.";
        nextSourceStates.push(state);
        continue;
      }

      const matchedFiles = await this.getMatchedFiles(source.rootPath, source.include);
      state.discoveredFiles = matchedFiles.length;

      if (matchedFiles.length === 0) {
        state.status = "warning";
        state.issue = "Файлы аналитики не найдены.";
        nextSourceStates.push(state);
        continue;
      }

      let parseErrors = 0;

      for (const filePath of matchedFiles) {
        const fileStat = await fs.stat(filePath);
        const cached = this.cache.get(filePath);
        const canReuse = cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size;

        if (canReuse && cached) {
          nextCache.set(filePath, cached);
          parseErrors += cached.parseErrors;
          state.totalEntries += cached.entries.length;
          const latestEntry = cached.entries[0];
          if (latestEntry && (!state.lastEventAt || latestEntry.unixMs > Date.parse(state.lastEventAt))) {
            state.lastEventAt = latestEntry.timestamp;
          }
          continue;
        }

        const content = await fs.readFile(filePath, "utf-8");
        const parsed = parseLogContent(content, source, filePath, this.runtime.snippetLength);
        const sortedEntries = parsed.entries.sort((left, right) => right.unixMs - left.unixMs);

        nextCache.set(filePath, {
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          entries: sortedEntries,
          parseErrors: parsed.parseErrors,
        });

        parseErrors += parsed.parseErrors;
        state.totalEntries += sortedEntries.length;
        const latestEntry = sortedEntries[0];
        if (latestEntry && (!state.lastEventAt || latestEntry.unixMs > Date.parse(state.lastEventAt))) {
          state.lastEventAt = latestEntry.timestamp;
        }
      }

      if (parseErrors > 0) {
        state.status = "warning";
        state.issue = `Пропущено строк при разборе: ${parseErrors}`;
      }

      nextSourceStates.push(state);
    }

    this.cache = nextCache;
    this.sourceStates = nextSourceStates;
    this.entries = [...this.cache.values()]
      .flatMap((item) => item.entries)
      .sort((left, right) => right.unixMs - left.unixMs);
    this.lastRefreshAt = new Date().toISOString();
  }

  private async getMatchedFiles(rootPath: string, includePatterns: string[]): Promise<string[]> {
    let matchedFiles: string[] = [];

    for (const pattern of includePatterns) {
      const files = await fg(pattern, {
        cwd: rootPath,
        absolute: true,
        onlyFiles: true,
        unique: true,
        suppressErrors: true,
      });
      matchedFiles = matchedFiles.concat(files);
    }

    return [...new Set(matchedFiles)].sort((left, right) => left.localeCompare(right));
  }
}
