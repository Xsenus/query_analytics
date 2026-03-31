import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express, { type NextFunction, type Request, type Response } from "express";

import { AnalyticsIndexer } from "./analytics/indexer.js";
import type { DashboardFilters, HistoryCleanupMode } from "./analytics/types.js";
import type { RuntimeConfig } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, "../../client");

function parseQueryList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalDate(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCleanupMode(value: unknown): HistoryCleanupMode | null {
  return value === "archive" || value === "delete" || value === "full_clear" ? value : null;
}

function parseFilters(request: Request): DashboardFilters {
  const resultValue = typeof request.query.result === "string" ? request.query.result : null;
  const recentPageRaw = typeof request.query.recentPage === "string" ? Number.parseInt(request.query.recentPage, 10) : 1;
  const recentPageSizeRaw =
    typeof request.query.recentPageSize === "string" ? Number.parseInt(request.query.recentPageSize, 10) : 15;

  return {
    fromMs: parseOptionalDate(request.query.from),
    toMs: parseOptionalDate(request.query.to),
    sourceIds: parseQueryList(request.query.source),
    provider: typeof request.query.provider === "string" && request.query.provider.trim() !== "" ? request.query.provider.trim() : null,
    result:
      resultValue === "positive" || resultValue === "negative" || resultValue === "unknown" ? resultValue : null,
    outcome: typeof request.query.outcome === "string" && request.query.outcome.trim() !== "" ? request.query.outcome.trim() : null,
    search: typeof request.query.search === "string" && request.query.search.trim() !== "" ? request.query.search.trim() : null,
    recentPage: Number.isFinite(recentPageRaw) && recentPageRaw > 0 ? recentPageRaw : 1,
    recentPageSize: Number.isFinite(recentPageSizeRaw) && recentPageSizeRaw > 0 ? recentPageSizeRaw : 15,
  };
}

export function createApp(runtime: RuntimeConfig) {
  const app = express();
  const analytics = new AnalyticsIndexer(runtime);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", async (_request, response, next) => {
    try {
      response.json(await analytics.getHealth(false));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/dashboard", async (request, response, next) => {
    try {
      const forceRefresh = request.query.refresh === "1";
      const payload = await analytics.getDashboard(parseFilters(request), forceRefresh);
      response.setHeader("Cache-Control", "no-store");
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/requests/:id", async (request, response, next) => {
    try {
      const forceRefresh = request.query.refresh === "1";
      const payload = await analytics.getRequestDetails(request.params.id, forceRefresh);

      if (!payload) {
        response.status(404).json({ error: "Запрос не найден." });
        return;
      }

      response.setHeader("Cache-Control", "no-store");
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/history/cleanup", async (request, response, next) => {
    try {
      const sourceIds = Array.isArray(request.body?.sourceIds)
        ? request.body.sourceIds.filter((item: unknown): item is string => typeof item === "string" && item.trim() !== "")
        : [];
      const before = typeof request.body?.before === "string" ? Date.parse(request.body.before) : Number.NaN;
      const mode = parseCleanupMode(request.body?.mode);

      if (!Number.isFinite(before)) {
        response.status(400).json({ error: "Поле before обязательно и должно быть корректной датой." });
        return;
      }

      if (mode === null) {
        response.status(400).json({ error: "Поле mode обязательно и должно быть archive, delete или full_clear." });
        return;
      }

      const payload = await analytics.cleanupHistory(sourceIds, before, mode);
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/history/archive", async (request, response, next) => {
    try {
      const sourceIds = Array.isArray(request.body?.sourceIds)
        ? request.body.sourceIds.filter((item: unknown): item is string => typeof item === "string" && item.trim() !== "")
        : [];
      const before = typeof request.body?.before === "string" ? Date.parse(request.body.before) : Number.NaN;

      if (!Number.isFinite(before)) {
        response.status(400).json({ error: "Поле before обязательно и должно быть корректной датой." });
        return;
      }

      const payload = await analytics.archiveHistory(sourceIds, before);
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sources/:sourceId/logging", async (request, response, next) => {
    try {
      if (typeof request.body?.enabled !== "boolean") {
        response.status(400).json({ error: "Поле enabled обязательно и должно быть boolean." });
        return;
      }

      const payload = await analytics.setSourceLoggingEnabled(request.params.sourceId, request.body.enabled);
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: "5m" }));
    app.get(/^(?!\/api|\/healthz).*/, (_request, response) => {
      response.sendFile(path.join(clientDist, "index.html"));
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    response.status(500).json({ error: message });
  });

  return app;
}
