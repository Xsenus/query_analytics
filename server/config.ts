import fs from "node:fs";
import path from "node:path";

export type LogFormat = "auto" | "garage-jsonl" | "request-analytics" | "dotnet-jsonl";
export type LogControlApplyMode = "restart_service" | "next_run" | "manual";

export interface LogAnalyticsControlConfig {
  type: "env" | "json";
  key: string;
  filePath?: string;
  additionalFilePaths?: string[];
  enabledValue?: string;
  disabledValue?: string;
  defaultEnabled?: boolean;
  applyMode?: LogControlApplyMode;
  serviceName?: string;
  note?: string;
}

export interface LogSourceConfig {
  id: string;
  name: string;
  rootPath: string;
  include: string[];
  format?: LogFormat;
  analyticsControl?: LogAnalyticsControlConfig;
}

export interface RuntimeConfig {
  port: number;
  host: string;
  refreshIntervalMs: number;
  maxRecentRequests: number;
  snippetLength: number;
  sourcesConfigPath: string;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureStringList(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`Поле ${fieldName} должно быть массивом непустых строк.`);
  }

  return value.map((item) => item.trim());
}

function parseAnalyticsControl(value: unknown, fieldName: string): LogAnalyticsControlConfig | undefined {
  if (value == null) {
    return undefined;
  }

  if (!value || typeof value !== "object") {
    throw new Error(`Поле ${fieldName} должно быть объектом.`);
  }

  const control = value as Record<string, unknown>;
  const type = typeof control.type === "string" ? control.type.trim() : "";
  const key = typeof control.key === "string" ? control.key.trim() : "";
  const filePath = typeof control.filePath === "string" ? control.filePath.trim() : undefined;
  const additionalFilePaths =
    control.additionalFilePaths == null ? undefined : ensureStringList(control.additionalFilePaths, `${fieldName}.additionalFilePaths`);
  const enabledValue = typeof control.enabledValue === "string" ? control.enabledValue : undefined;
  const disabledValue = typeof control.disabledValue === "string" ? control.disabledValue : undefined;
  const defaultEnabled = typeof control.defaultEnabled === "boolean" ? control.defaultEnabled : undefined;
  const applyMode = typeof control.applyMode === "string" ? control.applyMode.trim() : undefined;
  const serviceName = typeof control.serviceName === "string" ? control.serviceName.trim() : undefined;
  const note = typeof control.note === "string" ? control.note.trim() : undefined;

  if (type !== "env" && type !== "json") {
    throw new Error(`${fieldName}.type должен быть env или json.`);
  }

  if (!key) {
    throw new Error(`${fieldName}.key обязателен.`);
  }

  if (applyMode && !["restart_service", "next_run", "manual"].includes(applyMode)) {
    throw new Error(`${fieldName}.applyMode имеет неподдерживаемое значение: ${applyMode}`);
  }

  return {
    type,
    key,
    filePath,
    additionalFilePaths,
    enabledValue,
    disabledValue,
    defaultEnabled,
    applyMode: applyMode as LogControlApplyMode | undefined,
    serviceName,
    note,
  };
}

export function loadRuntimeConfig(): RuntimeConfig {
  return {
    port: parseNumber(process.env.PORT, 3030),
    host: (process.env.HOST ?? "0.0.0.0").trim() || "0.0.0.0",
    refreshIntervalMs: parseNumber(process.env.REFRESH_INTERVAL_MS, 15_000),
    maxRecentRequests: parseNumber(process.env.MAX_RECENT_REQUESTS, 80),
    snippetLength: parseNumber(process.env.SNIPPET_LENGTH, 800),
    sourcesConfigPath: path.resolve(
      process.cwd(),
      (process.env.SOURCES_CONFIG_PATH ?? "./config/sources.local.json").trim() || "./config/sources.local.json",
    ),
  };
}

export function loadSourcesConfig(filePath: string): LogSourceConfig[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл конфигурации источников не найден: ${filePath}`);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("Конфигурация источников должна быть JSON-массивом.");
  }

  return raw.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Элемент sources[${index}] должен быть объектом.`);
    }

    const source = item as Record<string, unknown>;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    const name = typeof source.name === "string" ? source.name.trim() : "";
    const rootPath = typeof source.rootPath === "string" ? source.rootPath.trim() : "";
    const include = ensureStringList(source.include, `sources[${index}].include`);
    const format = typeof source.format === "string" ? source.format.trim() : "auto";
    const analyticsControl = parseAnalyticsControl(source.analyticsControl, `sources[${index}].analyticsControl`);

    if (!id) {
      throw new Error(`sources[${index}].id обязателен.`);
    }

    if (!name) {
      throw new Error(`sources[${index}].name обязателен.`);
    }

    if (!rootPath) {
      throw new Error(`sources[${index}].rootPath обязателен.`);
    }

    if (!["auto", "garage-jsonl", "request-analytics", "dotnet-jsonl"].includes(format)) {
      throw new Error(`sources[${index}].format имеет неподдерживаемое значение: ${format}`);
    }

    return {
      id,
      name,
      rootPath: path.resolve(rootPath),
      include,
      format: format as LogFormat,
      analyticsControl,
    };
  });
}
