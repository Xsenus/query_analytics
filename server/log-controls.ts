import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { LogAnalyticsControlConfig, LogControlApplyMode, LogSourceConfig } from "./config.js";
import type { SourceLogControlState, UpdateSourceLogControlResult } from "./analytics/types.js";

const execFileAsync = promisify(execFile);

interface ResolvedLogControl {
  type: "env" | "json";
  key: string;
  filePaths: string[];
  enabledValue: string;
  disabledValue: string;
  defaultEnabled: boolean;
  applyMode: LogControlApplyMode;
  serviceName: string | null;
  note: string | null;
}

function resolveConfiguredPaths(rootPath: string, control: LogAnalyticsControlConfig): string[] {
  const candidates = [control.filePath, ...(control.additionalFilePaths ?? [])].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );

  return candidates.map((item) => (path.isAbsolute(item) ? item : path.resolve(rootPath, item)));
}

function inferDefaultControl(source: LogSourceConfig): LogAnalyticsControlConfig | null {
  switch (source.id) {
    case "garage-sync":
      return {
        type: "env",
        key: "REQUEST_AUDIT_ENABLED",
        filePath: ".env",
        additionalFilePaths: ["current/.env"],
        enabledValue: "true",
        disabledValue: "false",
        defaultEnabled: true,
        applyMode: "next_run",
        serviceName: "abcp-b24-garage-sync.service",
        note: "Изменение применится на следующем запуске таймера abcp-b24-garage-sync.timer.",
      };
    case "abcp-b24-sync":
      return {
        type: "env",
        key: "REQUEST_ANALYTICS_ENABLED",
        filePath: ".env",
        additionalFilePaths: ["current/.env"],
        enabledValue: "1",
        disabledValue: "0",
        defaultEnabled: true,
        applyMode: "restart_service",
        serviceName: "abcp-b24-sync.service",
      };
    case "abcp2bitrix":
      return {
        type: "json",
        key: "RuntimeOptions.EnableHttpRequestAnalytics",
        filePath: "server_config.json",
        additionalFilePaths: ["../shared/server_config.json", "ABCP2Bitrix.Infrastructure/server_config.json"],
        defaultEnabled: true,
        applyMode: "restart_service",
        serviceName: "ABCP2Bitrix.service",
      };
    default:
      return null;
  }
}

function resolveLogControl(source: LogSourceConfig): ResolvedLogControl | null {
  const control = source.analyticsControl ?? inferDefaultControl(source);
  if (!control) {
    return null;
  }

  const filePaths = resolveConfiguredPaths(source.rootPath, control);

  return {
    type: control.type,
    key: control.key,
    filePaths,
    enabledValue: control.enabledValue ?? "true",
    disabledValue: control.disabledValue ?? "false",
    defaultEnabled: control.defaultEnabled ?? true,
    applyMode: control.applyMode ?? "manual",
    serviceName: control.serviceName ?? null,
    note: control.note ?? null,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingPaths(filePaths: string[]): Promise<string[]> {
  const resolved = new Set<string>();

  for (const filePath of filePaths) {
    if (!(await pathExists(filePath))) {
      continue;
    }

    let uniquePath = filePath;

    try {
      uniquePath = await fs.realpath(filePath);
    } catch {
      uniquePath = filePath;
    }

    resolved.add(uniquePath);
  }

  return [...resolved];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBooleanText(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

function parseEnabledValue(
  rawValue: string | null,
  enabledValue: string,
  disabledValue: string,
  defaultEnabled: boolean,
): boolean {
  if (rawValue === null) {
    return defaultEnabled;
  }

  const normalized = normalizeBooleanText(rawValue);
  const normalizedEnabled = normalizeBooleanText(enabledValue);
  const normalizedDisabled = normalizeBooleanText(disabledValue);

  if (normalized === normalizedEnabled) {
    return true;
  }

  if (normalized === normalizedDisabled) {
    return false;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultEnabled;
}

function readEnvVariable(content: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`);

  for (const line of content.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) {
      continue;
    }

    const match = line.match(pattern);
    if (match) {
      return match[1] ?? "";
    }
  }

  return null;
}

function buildEnvContent(content: string, key: string, value: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content === "" ? [] : content.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let replaced = false;

  const nextLines = lines.map((line) => {
    if (line.trimStart().startsWith("#") || !pattern.test(line)) {
      return line;
    }

    replaced = true;
    return `${key}=${value}`;
  });

  if (!replaced) {
    nextLines.push(`${key}=${value}`);
  }

  return `${nextLines.filter((line, index, items) => index < items.length - 1 || line !== "").join(newline)}${newline}`;
}

function readJsonBoolean(content: string, keyPath: string, defaultEnabled: boolean): boolean {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  let current: unknown = parsed;

  for (const segment of keyPath.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object") {
      return defaultEnabled;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current === "boolean") {
    return current;
  }

  if (typeof current === "string") {
    return parseEnabledValue(current, "true", "false", defaultEnabled);
  }

  return defaultEnabled;
}

function buildJsonContent(content: string, keyPath: string, enabled: boolean): string {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const segments = keyPath.split(".").filter(Boolean);
  let current: Record<string, unknown> = parsed;

  for (const segment of segments.slice(0, -1)) {
    const nextValue = current[segment];

    if (!nextValue || typeof nextValue !== "object" || Array.isArray(nextValue)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }

  current[segments[segments.length - 1]!] = enabled;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function buildDefaultNote(control: ResolvedLogControl): string {
  if (control.note) {
    return control.note;
  }

  if (control.applyMode === "restart_service" && control.serviceName) {
    return `После изменения панель перезапустит ${control.serviceName}.`;
  }

  if (control.applyMode === "next_run") {
    return "Изменение применится при следующем запуске сервиса.";
  }

  if (control.serviceName) {
    return `Для применения может понадобиться ручной перезапуск ${control.serviceName}.`;
  }

  return "Для применения может понадобиться ручной перезапуск сервиса.";
}

async function restartService(serviceName: string): Promise<{ performed: boolean; message: string }> {
  try {
    await execFileAsync("systemctl", ["restart", serviceName]);
    return {
      performed: true,
      message: `Настройка сохранена. Сервис ${serviceName} перезапущен.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      performed: false,
      message: `Настройка сохранена, но сервис ${serviceName} не удалось перезапустить автоматически: ${message}`,
    };
  }
}

function buildUnsupportedState(error: string | null = null): SourceLogControlState {
  return {
    supported: false,
    enabled: null,
    filePath: null,
    applyMode: "manual",
    serviceName: null,
    note: null,
    error,
  };
}

export async function readSourceLogControlState(source: LogSourceConfig): Promise<SourceLogControlState> {
  const control = resolveLogControl(source);
  if (!control) {
    return buildUnsupportedState("Для этого источника управление логированием не настроено.");
  }

  const existingPaths = await resolveExistingPaths(control.filePaths);
  const primaryPath = existingPaths[0] ?? control.filePaths[0] ?? null;

  try {
    if (control.type === "env") {
      if (!primaryPath || !(await pathExists(primaryPath))) {
        return {
          supported: primaryPath !== null,
          enabled: control.defaultEnabled,
          filePath: primaryPath,
          applyMode: control.applyMode,
          serviceName: control.serviceName,
          note: buildDefaultNote(control),
          error: primaryPath ? null : "Не удалось определить env-файл сервиса.",
        };
      }

      const content = await fs.readFile(primaryPath, "utf8");
      const rawValue = readEnvVariable(content, control.key);

      return {
        supported: true,
        enabled: parseEnabledValue(rawValue, control.enabledValue, control.disabledValue, control.defaultEnabled),
        filePath: primaryPath,
        applyMode: control.applyMode,
        serviceName: control.serviceName,
        note: buildDefaultNote(control),
        error: null,
      };
    }

    if (!primaryPath || !(await pathExists(primaryPath))) {
      return buildUnsupportedState("Не найден файл JSON-конфигурации сервиса.");
    }

    const content = await fs.readFile(primaryPath, "utf8");

    return {
      supported: true,
      enabled: readJsonBoolean(content, control.key, control.defaultEnabled),
      filePath: primaryPath,
      applyMode: control.applyMode,
      serviceName: control.serviceName,
      note: buildDefaultNote(control),
      error: null,
    };
  } catch (error) {
    return buildUnsupportedState(error instanceof Error ? error.message : String(error));
  }
}

export async function readAllSourceLogControlStates(sources: LogSourceConfig[]): Promise<Map<string, SourceLogControlState>> {
  const entries = await Promise.all(
    sources.map(async (source) => {
      const state = await readSourceLogControlState(source);
      return [source.id, state] as const;
    }),
  );

  return new Map(entries);
}

export async function updateSourceLogControl(source: LogSourceConfig, enabled: boolean): Promise<UpdateSourceLogControlResult> {
  const control = resolveLogControl(source);
  if (!control) {
    throw new Error("Для этого источника управление логированием не настроено.");
  }

  const stateBefore = await readSourceLogControlState(source);
  if (!stateBefore.supported) {
    throw new Error(stateBefore.error ?? "Управление логированием недоступно.");
  }

  const existingPaths = await resolveExistingPaths(control.filePaths);
  const writeTargets = existingPaths.length > 0 ? existingPaths : control.filePaths.slice(0, 1);

  if (writeTargets.length === 0) {
    throw new Error("Не удалось определить путь к конфигурации логирования.");
  }

  const nextRawValue = enabled ? control.enabledValue : control.disabledValue;

  for (const filePath of writeTargets) {
    const exists = await pathExists(filePath);
    const content = exists ? await fs.readFile(filePath, "utf8") : "";

    if (control.type === "env") {
      await writeFileAtomic(filePath, buildEnvContent(content, control.key, nextRawValue));
      continue;
    }

    if (!exists) {
      throw new Error(`Файл JSON-конфигурации не найден: ${filePath}`);
    }

    await writeFileAtomic(filePath, buildJsonContent(content, control.key, enabled));
  }

  let message = `Настройка сохранена. Логирование ${enabled ? "включено" : "выключено"}.`;

  if (control.applyMode === "restart_service" && control.serviceName) {
    const restartResult = await restartService(control.serviceName);
    message = restartResult.message;
  } else if (control.applyMode === "next_run") {
    message = `Настройка сохранена. ${buildDefaultNote(control)}`;
  } else if (control.serviceName) {
    message = `Настройка сохранена. Для применения перезапустите ${control.serviceName} вручную.`;
  }

  const stateAfter = await readSourceLogControlState(source);

  return {
    sourceId: source.id,
    sourceName: source.name,
    enabled,
    previousEnabled: stateBefore.enabled,
    message,
    control: stateAfter,
  };
}
