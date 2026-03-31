import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type { LogSourceConfig } from "../config.js";
import type { NormalizedEntry } from "./types.js";

interface ParseResult {
  entries: NormalizedEntry[];
  parseErrors: number;
}

type ParseMode = "preview" | "full";

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

function compactText(value: string | null, limit: number, mode: ParseMode): string | null {
  if (value === null) {
    return null;
  }

  return mode === "full" ? value : truncate(value, limit);
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

function normalizeOutcome(
  value: unknown,
  result: "positive" | "negative" | "unknown",
  fallbackStatusCode: number | null = null,
): string {
  const normalized = asString(value)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");

  switch (normalized) {
    case undefined:
    case null:
      return result === "positive" ? "success" : result;
    case "positive":
    case "success":
    case "ok":
      return "success";
    case "negative":
      return fallbackStatusCode !== null && fallbackStatusCode >= 400 ? "http_error" : "negative";
    case "http":
    case "http_error":
      return "http_error";
    case "application_error":
    case "app_error":
      return "application_error";
    case "empty":
    case "empty_response":
      return "empty";
    case "exception":
    case "exception_error":
      return "exception";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "unknown":
      return "unknown";
    default:
      return normalized;
  }
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

function resolveBody(value: unknown, mode: ParseMode): { body: string | null; isAvailable: boolean } {
  const body = toBodyText(value);

  if (body === null) {
    return { body: null, isAvailable: false };
  }

  return {
    body: mode === "full" ? body : null,
    isAvailable: true,
  };
}

function resolvePreview(value: unknown, limit: number, mode: ParseMode): string | null {
  return mode === "full" ? toPreview(value, limit) : null;
}

function resolvePayloadSize(value: unknown, mode: ParseMode): number | null {
  return mode === "full" ? toPayloadSize(value) : null;
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
  mode: ParseMode,
): NormalizedEntry | null {
  const timestamp = asString(raw.timestamp);
  if (!timestamp) {
    return null;
  }

  const request = (raw.request ?? {}) as Record<string, unknown>;
  const response = (raw.response ?? {}) as Record<string, unknown>;
  const urlParts = parseUrl(asString(request.url));
  const durationMs = asNumber(response.duration_ms);
  const statusCode = asNumber(response.status_code);
  const successValue = typeof response.ok === "boolean" ? response.ok : null;
  const result = successValue === null ? "unknown" : successValue ? "positive" : "negative";
  const operation = asString(((raw.meta ?? {}) as Record<string, unknown>).bitrix_method) ?? deriveOperation(urlParts.path, "request");
  const outcome = normalizeOutcome(response.outcome, result, statusCode);
  const requestBody = resolveBody(request.payload ?? request.headers, mode);
  const responseBody = resolveBody(response.body_preview, "full");
  const storedUrl = compactText(urlParts.url, 240, mode);
  const storedQuery = mode === "full" ? urlParts.query : null;

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
    url: storedUrl,
    host: urlParts.host,
    path: urlParts.path,
    query: storedQuery,
    statusCode,
    durationMs,
    result,
    outcome,
    success: successValue,
    error: asString(response.error),
    requestPreview: resolvePreview(request.payload ?? request.headers, snippetLength, mode),
    responsePreview: resolvePreview(response.body_preview, snippetLength, mode),
    requestBody: requestBody.body,
    responseBody: responseBody.body,
    requestBodyComplete: mode === "full" || !requestBody.isAvailable,
    responseBodyComplete: false,
    requestSize: resolvePayloadSize(request.payload, mode),
    responseSize: asNumber(response.content_length),
    metaPreview: resolvePreview(raw.meta, snippetLength, mode),
  };
}

function parseLegacyPythonRecord(
  raw: Record<string, unknown>,
  source: LogSourceConfig,
  filePath: string,
  fileName: string,
  lineNumber: number,
  snippetLength: number,
  mode: ParseMode,
): NormalizedEntry | null {
  const timestamp = asString(raw.timestamp);
  if (!timestamp) {
    return null;
  }

  const urlParts = parseUrl(asString(raw.url));
  const successValue = typeof raw.success === "boolean" ? raw.success : null;
  const result = successValue === null ? "unknown" : successValue ? "positive" : "negative";
  const statusCode = asNumber(raw.http_status);
  const operation = asString(raw.operation) ?? deriveOperation(urlParts.path, "request");
  const outcome = normalizeOutcome(raw.outcome, result, statusCode);
  const requestBody = resolveBody(raw.request, mode);
  const responseBody = resolveBody(raw.response, mode);
  const storedUrl = compactText(urlParts.url, 240, mode);
  const storedQuery = mode === "full" ? urlParts.query : null;

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
    url: storedUrl,
    host: urlParts.host,
    path: urlParts.path,
    query: storedQuery,
    statusCode,
    durationMs: asNumber(raw.duration_ms),
    result,
    outcome,
    success: successValue,
    error: asString(raw.error),
    requestPreview: resolvePreview(raw.request, snippetLength, mode),
    responsePreview: resolvePreview(raw.response, snippetLength, mode),
    requestBody: requestBody.body,
    responseBody: responseBody.body,
    requestBodyComplete: mode === "full" || !requestBody.isAvailable,
    responseBodyComplete: mode === "full" || !responseBody.isAvailable,
    requestSize: resolvePayloadSize(raw.request, mode),
    responseSize: resolvePayloadSize(raw.response, mode),
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
  mode: ParseMode,
): NormalizedEntry | null {
  const timestamp = asString(raw.timestamp);
  if (!timestamp) {
    return null;
  }

  const urlParts = parseUrl(asString(raw.url));
  const statusCode = asNumber(raw.statusCode);
  const result = normalizeResult(raw.result, raw.isSuccessStatusCode === true ? "positive" : "negative");
  const outcome = normalizeOutcome(raw.outcome, result, statusCode);
  const operation = deriveOperation(urlParts.path, asString(raw.destination) ?? "request");
  const requestBody = resolveBody(raw.requestBody, mode);
  const responseBody = resolveBody(raw.responseBody, mode);
  const storedUrl = compactText(urlParts.url, 240, mode);
  const storedQuery = mode === "full" ? asString(raw.query) ?? urlParts.query : null;

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
    url: storedUrl,
    host: urlParts.host,
    path: urlParts.path,
    query: storedQuery,
    statusCode,
    durationMs: asNumber(raw.durationMs),
    result,
    outcome,
    success: result === "unknown" ? null : result === "positive",
    error: asString(raw.applicationError) ?? asString(raw.exceptionMessage),
    requestPreview: resolvePreview(raw.requestBody, snippetLength, mode),
    responsePreview: resolvePreview(raw.responseBody, snippetLength, mode),
    requestBody: requestBody.body,
    responseBody: responseBody.body,
    requestBodyComplete: mode === "full" || !requestBody.isAvailable,
    responseBodyComplete: mode === "full" || !responseBody.isAvailable,
    requestSize: asNumber(raw.requestBodyLength),
    responseSize: asNumber(raw.responseBodyLength),
    metaPreview: resolvePreview(raw.scope, snippetLength, mode),
  };
}

function parseLogLine(
  rawLine: string,
  source: LogSourceConfig,
  filePath: string,
  fileName: string,
  lineNumber: number,
  snippetLength: number,
  mode: ParseMode,
): { entry: NormalizedEntry | null; parseError: boolean } {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return { entry: null, parseError: false };
  }

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const format = detectFormat(payload, source, fileName);
    let entry: NormalizedEntry | null = null;

    switch (format) {
      case "garage-jsonl":
        entry = parseGarageRecord(payload, source, filePath, fileName, lineNumber, snippetLength, mode);
        break;
      case "request-analytics":
        entry = parseLegacyPythonRecord(payload, source, filePath, fileName, lineNumber, snippetLength, mode);
        break;
      case "dotnet-jsonl":
        entry = parseDotnetRecord(payload, source, filePath, fileName, lineNumber, snippetLength, mode);
        break;
      default:
        return { entry: null, parseError: true };
    }

    if (entry && Number.isFinite(entry.unixMs)) {
      return { entry, parseError: false };
    }

    return { entry: null, parseError: entry !== null };
  } catch {
    return { entry: null, parseError: true };
  }
}

export async function parseLogFile(
  filePath: string,
  source: LogSourceConfig,
  snippetLength: number,
  mode: ParseMode = "preview",
): Promise<ParseResult> {
  const fileName = path.basename(filePath);
  const entries: NormalizedEntry[] = [];
  let parseErrors = 0;
  let lineNumber = 0;

  const reader = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      lineNumber += 1;
      const parsed = parseLogLine(line, source, filePath, fileName, lineNumber, snippetLength, mode);

      if (parsed.parseError) {
        parseErrors += 1;
      }

      if (parsed.entry) {
        entries.push(parsed.entry);
      }
    }
  } finally {
    reader.close();
  }

  return { entries, parseErrors };
}

export async function parseLogEntryAtLine(
  filePath: string,
  source: LogSourceConfig,
  snippetLength: number,
  targetLineNumber: number,
  mode: ParseMode = "full",
): Promise<NormalizedEntry | null> {
  if (!Number.isFinite(targetLineNumber) || targetLineNumber <= 0) {
    return null;
  }

  const fileName = path.basename(filePath);
  let lineNumber = 0;

  const reader = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber !== targetLineNumber) {
        continue;
      }

      const parsed = parseLogLine(line, source, filePath, fileName, lineNumber, snippetLength, mode);
      return parsed.entry;
    }
  } finally {
    reader.close();
  }

  return null;
}

export function parseLogContent(
  content: string,
  source: LogSourceConfig,
  filePath: string,
  snippetLength: number,
  mode: ParseMode = "full",
): ParseResult {
  const fileName = path.basename(filePath);
  const entries: NormalizedEntry[] = [];
  let parseErrors = 0;

  for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
    const parsed = parseLogLine(line, source, filePath, fileName, lineIndex + 1, snippetLength, mode);

    if (parsed.parseError) {
      parseErrors += 1;
    }

    if (parsed.entry) {
      entries.push(parsed.entry);
    }
  }

  return { entries, parseErrors };
}
