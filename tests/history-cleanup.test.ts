import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { AnalyticsIndexer } from "../server/analytics/indexer.js";
import type { RuntimeConfig } from "../server/config.js";

async function createRuntimeWithSource(rootPath: string): Promise<RuntimeConfig> {
  const configPath = path.join(rootPath, "sources.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      [
        {
          id: "test-source",
          name: "Test source",
          rootPath,
          include: ["logs/http-requests-*.jsonl"],
          format: "garage-jsonl",
        },
      ],
      null,
      2,
    ),
    "utf8",
  );

  return {
    port: 3030,
    host: "0.0.0.0",
    refreshIntervalMs: 15_000,
    maxRecentRequests: 15,
    snippetLength: 120,
    sourcesConfigPath: configPath,
  };
}

async function writeOldFile(filePath: string, content = ""): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  const oldDate = new Date("2000-01-02T03:04:05.000Z");
  await fs.utimes(filePath, oldDate, oldDate);
}

async function writeGzipFile(filePath: string, content = "", oldMtime = false): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, gzipSync(content));

  if (oldMtime) {
    const oldDate = new Date("2000-01-02T03:04:05.000Z");
    await fs.utimes(filePath, oldDate, oldDate);
  }
}

function normalizeForAssert(filePath: string | null | undefined): string | null {
  return filePath ? path.normalize(filePath) : null;
}

describe("history cleanup", () => {
  it("archives only eligible old files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "query-analytics-cleanup-archive-"));
    const logsDir = path.join(tempDir, "logs");
    const oldFile = path.join(logsDir, "http-requests-2000-01-01.jsonl");
    const todayFile = path.join(logsDir, `http-requests-${new Date().toISOString().slice(0, 10)}.jsonl`);

    await writeOldFile(oldFile, '{"id":"old"}\n');
    await writeOldFile(todayFile);

    try {
      const runtime = await createRuntimeWithSource(tempDir);
      const indexer = new AnalyticsIndexer(runtime);
      const result = await indexer.cleanupHistory([], Date.now(), "archive");
      const archiveRoot = path.join(tempDir, ".query-analytics-archive");
      const archivedFiles = await fs.readdir(archiveRoot, { recursive: true });

      expect(result.mode).toBe("archive");
      expect(result.archivedFiles).toBe(1);
      expect(result.deletedFiles).toBe(0);
      expect(result.skippedFiles).toBe(1);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.action).toBe("archived");
      expect(normalizeForAssert(result.files[0]?.filePath)).toBe(path.normalize(oldFile));
      expect(normalizeForAssert(result.files[0]?.destinationPath)).toContain(path.normalize(path.join(".query-analytics-archive")));
      expect(normalizeForAssert(result.files[0]?.destinationPath)).toContain("http-requests-2000-01-01.jsonl.gz");
      expect(gunzipSync(await fs.readFile(result.files[0]!.destinationPath!)).toString("utf8")).toBe('{"id":"old"}\n');
      await expect(fs.access(oldFile)).rejects.toThrow();
      await expect(fs.access(todayFile)).resolves.toBeUndefined();
      expect(archivedFiles.some((item) => String(item).endsWith("http-requests-2000-01-01.jsonl.gz"))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes eligible old files and archived copies", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "query-analytics-cleanup-delete-"));
    const oldFile = path.join(tempDir, "logs", "http-requests-2000-01-01.jsonl");
    const archivedFile = path.join(tempDir, ".query-analytics-archive", "recent", "logs", "http-requests-2000-01-01.jsonl.gz");

    await writeOldFile(oldFile);
    await writeGzipFile(archivedFile, '{"id":"archived"}\n');

    try {
      const runtime = await createRuntimeWithSource(tempDir);
      const indexer = new AnalyticsIndexer(runtime);
      const result = await indexer.cleanupHistory([], Date.now(), "delete");

      expect(result.mode).toBe("delete");
      expect(result.archivedFiles).toBe(0);
      expect(result.deletedFiles).toBe(2);
      expect(result.affectedFiles).toBe(2);
      expect(
        result.files.some(
          (item) => normalizeForAssert(item.filePath) === path.normalize(oldFile) && item.action === "deleted" && item.destinationPath === null,
        ),
      ).toBe(true);
      expect(
        result.files.some(
          (item) =>
            normalizeForAssert(item.filePath) === path.normalize(archivedFile) &&
            item.action === "deleted" &&
            item.destinationPath === null,
        ),
      ).toBe(true);
      await expect(fs.access(oldFile)).rejects.toThrow();
      await expect(fs.access(archivedFile)).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fully clears old logs and archive directory while keeping current day files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "query-analytics-cleanup-full-"));
    const oldFile = path.join(tempDir, "logs", "http-requests-2000-01-01.jsonl");
    const todayFile = path.join(tempDir, "logs", `http-requests-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const archivedFile = path.join(tempDir, ".query-analytics-archive", "old", "logs", "http-requests-1999-12-31.jsonl.gz");

    await writeOldFile(oldFile);
    await writeOldFile(todayFile);
    await writeGzipFile(archivedFile, '{"id":"archived"}\n', true);

    try {
      const runtime = await createRuntimeWithSource(tempDir);
      const indexer = new AnalyticsIndexer(runtime);
      const result = await indexer.cleanupHistory([], Date.now(), "full_clear");

      expect(result.mode).toBe("full_clear");
      expect(result.deletedFiles).toBe(2);
      expect(result.affectedFiles).toBe(2);
      expect(result.files).toHaveLength(2);
      expect(
        result.files.some(
          (item) => normalizeForAssert(item.filePath) === path.normalize(oldFile) && item.action === "deleted" && item.destinationPath === null,
        ),
      ).toBe(true);
      expect(
        result.files.some(
          (item) =>
            normalizeForAssert(item.filePath) === path.normalize(archivedFile) &&
            item.action === "deleted" &&
            item.destinationPath === null,
        ),
      ).toBe(true);
      await expect(fs.access(oldFile)).rejects.toThrow();
      await expect(fs.access(path.join(tempDir, ".query-analytics-archive"))).rejects.toThrow();
      await expect(fs.access(todayFile)).resolves.toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
