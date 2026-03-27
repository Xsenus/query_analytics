import path from "node:path";

import type { LogSourceConfig } from "../config.js";
import type { NormalizedEntry } from "./types.js";

interface ParseResult {
  entries: NormalizedEntry[];
  parseErrors: number;
}

function normalizeProviderName(value: string | null): string {
  const normalized = (value ?? "UNKNOWN").trim().toUpperCase();

  if (normalized === "BITRIX24" || normalized === "BITRIX 24") {
    return "BITRIX";
  }

  return normalized;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...`;
}

function toPreview(value: unknown, limit: number): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    return truncate(value, limit);
  }

  try {
    return truncate(JSON.stringify(value), limit);
  } catch {
    return truncate(String(value), limit);
  }
}

function toBodyText(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toPayloadSize(value: unknown): number | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    return value.length;
  }

  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function parseUrl(input: string | null): { url: string | null; host: string | null; path: string | null; query: string | null } {
  if (!input) {
    return { url: null, host: null, path: null, query: null };
  }

  try {
    const parsed = new URL(input);
    return {
      url: input,
      host: parsed.host || null,
      path: parsed.pathname || null,
      query: parsed.search ? parsed.search.slice(1) : null,
    };
  } catch {
    return { url: input, host: null, path: null, query: null };
  }
}

function normalizeResult(value: unknown, fallback: "positive" | "negative" | "unknown"): "positive" | "negative" | "unknown" {
  if (value === "positive" || value === "negative" || value === "unknown") {
    return value;
  }

  return fallback;
}

function detectFormat(raw: Record<string, unknown>, source: LogSourceConfig, fileName: string): Exclude<LogSourceConfig["format"], "auto"> | null {
  if (source.format && source.format !== "auto") {
    return source.format;
  }

  if ("service" in raw && "request" in raw && "response" in raw) {
    return "garage-jsonl";
  }

  if ("provider" in raw && "http_method" in raw) {
    return "request-analytics";
  }

  if ("destination" in raw && "method" in raw) {
    return "dotnet-jsonl";
  }

  if (fileName.startsWith("request_analytics_")) {
    return "request-analytics";
  }

  return null;
}

function deriveOperation(pathValue: string | null, fallback: string): string {
  if (!pathValue) {
    return fallback;
  }

  const normalized = pathValue.replace(/^\/+/, "");
  if (!normalized) {
    return fallback;
  }

  if (normalized.startsWith("rest/")) {
    const segments = normalized.split("/");
    return segments[segments.length - 1] || fallback;
  }

  if (normalized.startsWith("cp/")) {
    return normalized.slice(3) || fallback;
  }

  return normalized;
}

function buildEntryId(sourceId: string, fileName: string, lineNumber: number): string {
  return `${sourceId}:${fileName}:${lineNumber}`;
}

function parseGarageRecord(
  raw: Record<string, unknown>,
  source: LogSourceConfig,
  filePath: string,
  fileName: string,
  lineNumber: number,
  snippetLength: number,
): NormalizedEntry | null {
  const timestamp = asString(raw.timestamp);
  if (!timestamp) {
    return null;
  }

  const request = (raw.request ?? {}) as Record<string, unknown>;
  const response = (raw.response ?? {}) as Record<string, unknown>;
  const urlParts = parseUrl(asString(request.url));
  const durationMs = asNumber(response.duration_ms);
  const successValue = typeof response.ok === "boolean" ? response.ok : null;
  const result = successValue === null ? "unknown" : successValue ? "positive" : "negative";
  const operation = asString(((raw.meta ?? {}) as Record<string, unknown>).bitrix_method) ?? deriveOperation(urlParts.path, "request");

  return {
    id: buildEntryId(source.id, fileName, lineNumber),
    sourceId: source.id,
    sourceName: source.name,
    format: "garage-jsonl",
    filePath,
    fileName,
    timestamp,
    completedAt: null,
    unixMs: Date.parse(timestamp),
    provider: normalizeProviderName(asString(raw.service)),
    operation,
    endpoint: `${(asString(request.method) ?? "GET").toUpperCase()} ${operation}`,
    method: (asString(request.method) ?? "GET").toUpperCase(),
    url: urlParts.url,
    host: urlParts.host,
    path: urlParts.path,
    query: urlParts.query,
    statusCode: asNumber(response.status_code),
    durationMs,
    result,
    outcome: asString(response.outcome) ?? result,
    success: successValue,
    error: asString(response.error),
    requestPreview: toPreview(request.payload ?? request.headers, snippetLength),
    responsePreview: toPreview(response.body_preview, snippetLength),
    requestBody: toBodyText(request.payload ?? request.headers),
    responseBody: toBodyText(response.body_preview),
    requestBodyComplete: true,
    responseBodyComplete: false,
    requestSize: toPayloadSize(request.payload),
    responseSize: asNumber(response.content_length),
    metaPreview: toPreview(raw.meta, snippetLength),
  };
}

function parseLegacyPythonRecord(
  raw: Record<string, unknown>,
  source: LogSourceConfig,
  filePath: string,
  fileName: string,
  lineNumber: number,
  snippetLength: number,
): NormalizedEntry | null {
  const timestamp = asString(raw.timestamp);
  if (!timestamp) {
    return null;
  }

  const urlParts = parseUrl(asString(raw.url));
  const successValue = typeof raw.success === "boolean" ? raw.success : null;
  const result = successValue === null ? "unknown" : successValue ? "positive" : "negative";
  const operation = asString(raw.operation) ?? deriveOperation(urlParts.path, "request");

  return {
    id: buildEntryId(source.id, fileName, lineNumber),
    sourceId: source.id,
    sourceName: source.name,
    format: "request-analytics",
    filePath,
    fileName,
    timestamp,
    completedAt: null,
    unixMs: Date.parse(timestamp),
    provider: normalizeProviderName(asString(raw.provider)),
    operation,
    endpoint: `${(asString(raw.http_method) ?? "GET").toUpperCase()} ${operation}`,
    method: (asString(raw.http_method) ?? "GET").toUpperCase(),
    url: urlParts.url,
    host: urlParts.host,
    path: urlParts.path,
    query: urlParts.query,
    statusCode: asNumber(raw.http_status),
    durationMs: asNumber(raw.duration_ms),
    result,
    outcome: asString(raw.outcome) ?? result,
    success: successValue,
    error: asString(raw.error),
    requestPreview: toPreview(raw.request, snippetLength),
    responsePreview: toPreview(raw.response, snippetLength),
    requestBody: toBodyText(raw.request),
    responseBody: toBodyText(raw.response),
    requestBodyComplete: true,
    responseBodyComplete: true,
    requestSize: toPayloadSize(raw.request),
    responseSize: toPayloadSize(raw.response),
    metaPreview: null,
  };
}

function parseDotnetRecord(
  raw: Record<string, unknown>,
  source: LogSourceConfig,
  filePath: string,
  fileName: string,
  lineNumber: number,
  snippetLength: number,
): NormalizedEntry | null {
  const timestamp = asString(raw.timestamp);
  if (!timestamp) {
    return null;
  }

  const urlParts = parseUrl(asString(raw.url));
  const result = normalizeResult(raw.result, raw.isSuccessStatusCode === true ? "positive" : "negative");
  const operation = deriveOperation(urlParts.path, asString(raw.destination) ?? "request");

  return {
    id: buildEntryId(source.id, fileName, lineNumber),
    sourceId: source.id,
    sourceName: source.name,
    format: "dotnet-jsonl",
    filePath,
    fileName,
    timestamp,
    completedAt: asString(raw.completedAt),
    unixMs: Date.parse(timestamp),
    provider: normalizeProviderName(asString(raw.destination)),
    operation,
    endpoint: `${(asString(raw.method) ?? "GET").toUpperCase()} ${operation}`,
    method: (asString(raw.method) ?? "GET").toUpperCase(),
    url: urlParts.url,
    host: urlParts.host,
    path: urlParts.path,
    query: asString(raw.query) ?? urlParts.query,
    statusCode: asNumber(raw.statusCode),
    durationMs: asNumber(raw.durationMs),
    result,
    outcome: asString(raw.outcome) ?? result,
    success: result === "unknown" ? null : result === "positive",
    error: asString(raw.applicationError) ?? asString(raw.exceptionMessage),
    requestPreview: toPreview(raw.requestBody, snippetLength),
    responsePreview: toPreview(raw.responseBody, snippetLength),
    requestBody: toBodyText(raw.requestBody),
    responseBody: toBodyText(raw.responseBody),
    requestBodyComplete: true,
    responseBodyComplete: true,
    requestSize: asNumber(raw.requestBodyLength),
    responseSize: asNumber(raw.responseBodyLength),
    metaPreview: toPreview(raw.scope, snippetLength),
  };
}

export function parseLogContent(
  content: string,
  source: LogSourceConfig,
  filePath: string,
  snippetLength: number,
): ParseResult {
  const fileName = path.basename(filePath);
  const entries: NormalizedEntry[] = [];
  let parseErrors = 0;

  for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
    const rawLine = line.trim();
    if (!rawLine) {
      continue;
    }

    try {
      const payload = JSON.parse(rawLine) as Record<string, unknown>;
      const format = detectFormat(payload, source, fileName);
      let entry: NormalizedEntry | null = null;

      switch (format) {
        case "garage-jsonl":
          entry = parseGarageRecord(payload, source, filePath, fileName, lineIndex + 1, snippetLength);
          break;
        case "request-analytics":
          entry = parseLegacyPythonRecord(payload, source, filePath, fileName, lineIndex + 1, snippetLength);
          break;
        case "dotnet-jsonl":
          entry = parseDotnetRecord(payload, source, filePath, fileName, lineIndex + 1, snippetLength);
          break;
        default:
          parseErrors += 1;
      }

      if (entry && Number.isFinite(entry.unixMs)) {
        entries.push(entry);
      } else if (entry) {
        parseErrors += 1;
      }
    } catch {
      parseErrors += 1;
    }
  }

  return { entries, parseErrors };
}
