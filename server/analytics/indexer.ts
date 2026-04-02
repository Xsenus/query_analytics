import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import fg from "fast-glob";

import { loadSourcesConfig, type RuntimeConfig } from "../config.js";
import { readAllSourceLogControlStates, updateSourceLogControl } from "../log-controls.js";
import { buildDashboardPayload } from "./aggregate.js";
import { parseLogEntryAtLine, parseLogFile } from "./parser.js";
import type {
  DashboardFilters,
  DashboardPayload,
  HistoryCleanupMode,
  HistoryCleanupResult,
  NormalizedEntry,
  RequestDetailsPayload,
  SourceState,
  UpdateSourceLogControlResult,
} from "./types.js";

interface CachedFile {
  size: number;
  mtimeMs: number;
  entries: NormalizedEntry[];
  parseErrors: number;
}

function parseLineNumberFromEntryId(id: string): number | null {
  const separatorIndex = id.lastIndexOf(":");
  if (separatorIndex < 0) {
    return null;
  }

  const lineNumber = Number.parseInt(id.slice(separatorIndex + 1), 10);
  return Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : null;
}

function getIndexedSnippetLength(snippetLength: number): number {
  return Math.min(snippetLength, 160);
}

function getArchiveRootPath(rootPath: string): string {
  return path.resolve(rootPath, ".query-analytics-archive");
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function getFileDate(filePath: string, fallbackMs: number): string {
  const dateMatch = path.basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
  return dateMatch?.[1] ?? new Date(fallbackMs).toISOString().slice(0, 10);
}

async function compressFileToGzip(filePath: string, archiveTarget: string): Promise<void> {
  await fs.mkdir(path.dirname(archiveTarget), { recursive: true });
  const temporaryPath = `${archiveTarget}.tmp-${process.pid}-${Date.now()}`;
  const fileStat = await fs.stat(filePath);

  try {
    await pipeline(createReadStream(filePath), createGzip({ level: 9 }), createWriteStream(temporaryPath));
    await fs.utimes(temporaryPath, fileStat.atime, fileStat.mtime).catch(() => undefined);
    await fs.rename(temporaryPath, archiveTarget);
    await fs.rm(filePath, { force: true });
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeEmptyDirectoriesUpward(startPath: string, stopPath: string): Promise<void> {
  const stopPathResolved = path.resolve(stopPath);
  let currentPath = path.resolve(startPath);

  while (isPathInsideRoot(currentPath, stopPathResolved)) {
    try {
      const entries = await fs.readdir(currentPath);
      if (entries.length > 0) {
        return;
      }

      await fs.rmdir(currentPath);
    } catch {
      return;
    }

    if (currentPath === stopPathResolved) {
      return;
    }

    currentPath = path.dirname(currentPath);
  }
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
    const payload = buildDashboardPayload(this.entries, this.sourceStates, filters, this.runtime, this.lastRefreshAt);
    const sources = loadSourcesConfig(this.runtime.sourcesConfigPath);
    const logControlStates = await readAllSourceLogControlStates(sources);

    payload.tables.sourceActivity = payload.tables.sourceActivity.map((source) => ({
      ...source,
      logControl:
        logControlStates.get(source.id) ?? {
          supported: false,
          enabled: null,
          filePath: null,
          applyMode: "manual",
          serviceName: null,
          note: null,
          error: "Для этого источника управление логированием не настроено.",
        },
    }));

    return payload;
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
    const cachedEntry = this.entries.find((item) => item.id === id);

    if (!cachedEntry) {
      return null;
    }

    const entry = (await this.readFullEntry(cachedEntry)) ?? cachedEntry;

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

  async cleanupHistory(sourceIds: string[], beforeMs: number, mode: HistoryCleanupMode): Promise<HistoryCleanupResult> {
    const sources = loadSourcesConfig(this.runtime.sourcesConfigPath);
    const selectedSources = sourceIds.length > 0 ? sources.filter((source) => sourceIds.includes(source.id)) : sources;
    const archiveStamp = new Date().toISOString().replaceAll(":", "-");
    const archiveRoot = ".query-analytics-archive";
    const todayIso = new Date().toISOString().slice(0, 10);
    const beforeIso = new Date(beforeMs).toISOString().slice(0, 10);
    const protectedMtimeMs = Date.now() - 10 * 60 * 1000;
    const result: HistoryCleanupResult = {
      mode,
      affectedFiles: 0,
      archivedFiles: 0,
      deletedFiles: 0,
      skippedFiles: 0,
      completedAt: new Date().toISOString(),
      archiveRoot: mode === "archive" ? archiveRoot : null,
      files: [],
      sources: [],
    };

    for (const source of selectedSources) {
      const matchedFiles = await this.getMatchedFiles(source.rootPath, source.include);
      const archiveRootPath = getArchiveRootPath(source.rootPath);
      let archivedFiles = 0;
      let deletedFiles = 0;
      let skippedFiles = 0;

      for (const filePath of matchedFiles) {
        const fileStat = await fs.stat(filePath);
        const fileDate = getFileDate(filePath, fileStat.mtimeMs);

        const isToday = fileDate >= todayIso;
        const isBeforeCutoff = mode === "full_clear" ? true : fileDate <= beforeIso;
        const isRecentlyModified = fileStat.mtimeMs >= protectedMtimeMs;

        if (!isBeforeCutoff || isToday || isRecentlyModified) {
          skippedFiles += 1;
          continue;
        }

        if (mode === "archive") {
          const relativePath = path.relative(source.rootPath, filePath);
          const archiveTarget = path.join(source.rootPath, archiveRoot, archiveStamp, `${relativePath}.gz`);
          await compressFileToGzip(filePath, archiveTarget);
          archivedFiles += 1;
          result.files.push({
            sourceId: source.id,
            sourceName: source.name,
            filePath,
            action: "archived",
            destinationPath: archiveTarget,
          });
          continue;
        }

        await fs.rm(filePath, { force: true });
        deletedFiles += 1;
        result.files.push({
          sourceId: source.id,
          sourceName: source.name,
          filePath,
          action: "deleted",
          destinationPath: null,
        });
      }

      if ((mode === "delete" || mode === "full_clear") && isPathInsideRoot(archiveRootPath, source.rootPath)) {
        try {
          await fs.access(archiveRootPath);
          const archivedEntries = await fg("**/*", {
            cwd: archiveRootPath,
            absolute: true,
            onlyFiles: true,
            suppressErrors: true,
          });

          if (mode === "full_clear") {
            deletedFiles += archivedEntries.length;
            result.files.push(
              ...archivedEntries.map((filePath) => ({
                sourceId: source.id,
                sourceName: source.name,
                filePath,
                action: "deleted" as const,
                destinationPath: null,
              })),
            );
            await fs.rm(archiveRootPath, { recursive: true, force: true });
          } else {
            for (const archiveFilePath of archivedEntries) {
              const archiveStat = await fs.stat(archiveFilePath);
              const fileDate = getFileDate(archiveFilePath, archiveStat.mtimeMs);
              const isToday = fileDate >= todayIso;
              const isBeforeCutoff = fileDate <= beforeIso;

              if (!isBeforeCutoff || isToday) {
                skippedFiles += 1;
                continue;
              }

              await fs.rm(archiveFilePath, { force: true });
              await removeEmptyDirectoriesUpward(path.dirname(archiveFilePath), archiveRootPath);
              deletedFiles += 1;
              result.files.push({
                sourceId: source.id,
                sourceName: source.name,
                filePath: archiveFilePath,
                action: "deleted",
                destinationPath: null,
              });
            }
          }
        } catch {
          // Ignore missing archive root during cleanup.
        }
      }

      const affectedFiles = archivedFiles + deletedFiles;
      result.affectedFiles += affectedFiles;
      result.archivedFiles += archivedFiles;
      result.deletedFiles += deletedFiles;
      result.skippedFiles += skippedFiles;
      result.sources.push({
        id: source.id,
        name: source.name,
        affectedFiles,
        archivedFiles,
        deletedFiles,
        skippedFiles,
      });
    }

    await this.refresh();
    return result;
  }

  async archiveHistory(sourceIds: string[], beforeMs: number): Promise<HistoryCleanupResult> {
    return this.cleanupHistory(sourceIds, beforeMs, "archive");
  }

  async setSourceLoggingEnabled(sourceId: string, enabled: boolean): Promise<UpdateSourceLogControlResult> {
    const source = loadSourcesConfig(this.runtime.sourcesConfigPath).find((item) => item.id === sourceId);

    if (!source) {
      throw new Error("Источник не найден.");
    }

    return updateSourceLogControl(source, enabled);
  }

  private async readFullEntry(cachedEntry: NormalizedEntry): Promise<NormalizedEntry | null> {
    const lineNumber = parseLineNumberFromEntryId(cachedEntry.id);
    if (lineNumber === null) {
      return null;
    }

    const source = loadSourcesConfig(this.runtime.sourcesConfigPath).find((item) => item.id === cachedEntry.sourceId);
    if (!source) {
      return null;
    }

    try {
      return await parseLogEntryAtLine(cachedEntry.filePath, source, this.runtime.snippetLength, lineNumber, "full");
    } catch {
      return null;
    }
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
    const indexedSnippetLength = getIndexedSnippetLength(this.runtime.snippetLength);

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
      const issueParts: string[] = [];
      let skippedReadFailures = 0;

      for (const filePath of matchedFiles) {
        try {
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

          const parsed = await parseLogFile(filePath, source, indexedSnippetLength, "preview");
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
        } catch (error) {
          skippedReadFailures += 1;
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[query-analytics] failed to index analytics file: ${filePath}. ${message}`);
        }
      }

      if (parseErrors > 0 || skippedReadFailures > 0) {
        state.status = "warning";
        if (parseErrors > 0) {
          issueParts.push(`Пропущено строк при разборе: ${parseErrors}.`);
        }
        if (skippedReadFailures > 0) {
          issueParts.push(`Не удалось прочитать файлов: ${skippedReadFailures}.`);
        }
        state.issue = issueParts.join(" ");
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
