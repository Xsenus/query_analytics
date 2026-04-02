import { useEffect, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cleanupHistory, fetchDashboard, fetchRequestDetails, updateSourceLogging } from "./api";
import type { DashboardPayload, HistoryCleanupMode, HistoryCleanupResult, RequestDetailsPayload } from "./types";

type RangePreset = "24h" | "7d" | "30d" | "90d";
type RecentRequest = DashboardPayload["tables"]["recentRequests"]["items"][number];
type SourceActivityItem = DashboardPayload["tables"]["sourceActivity"][number];

const numberFormat = new Intl.NumberFormat("ru-RU");
const presetLabels: Record<RangePreset, string> = { "24h": "24 часа", "7d": "7 дней", "30d": "30 дней", "90d": "90 дней" };
const presetDays: Record<RangePreset, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
const resultLabels: Record<string, string> = { positive: "Успешно", negative: "С ошибкой", unknown: "Не определено", total: "Всего" };
const outcomeLabels: Record<string, string> = {
  success: "Успешно",
  empty: "Пустой ответ",
  application_error: "Ошибка приложения",
  http_error: "HTTP ошибка",
  exception: "Исключение",
  canceled: "Отменено",
  positive: "Успешно",
  negative: "С ошибкой",
  unknown: "Не определено",
};
const providerLabels: Record<string, string> = { ABCP: "ABCP", BITRIX: "Битрикс24", VERSTA24: "Versta24" };
const sourceStatusLabels: Record<string, string> = { ok: "Норма", warning: "Внимание", missing: "Недоступно" };
const intervalLabels: Record<string, string> = { hour: "по часам", day: "по дням", month: "по месяцам" };
const cleanupModeLabels: Record<HistoryCleanupMode, string> = {
  archive: "Архивировать",
  delete: "Удалить старые логи",
  full_clear: "Полная очистка",
};
const outcomeColors = ["#0f766e", "#f59e0b", "#94a3b8", "#dc2626", "#7c3aed", "#475569"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function setDayBoundary(date: Date, boundary: "start" | "end"): Date {
  const nextDate = new Date(date);

  if (boundary === "start") {
    nextDate.setHours(0, 0, 0, 0);
    return nextDate;
  }

  nextDate.setHours(23, 59, 59, 0);
  return nextDate;
}

function normalizeRangeValue(value: string, boundary: "start" | "end"): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }

  return toInputValue(setDayBoundary(date, boundary));
}

function presetToRange(preset: RangePreset): { from: string; to: string } {
  const to = setDayBoundary(new Date(), "end");
  const from = setDayBoundary(to, "start");
  from.setDate(from.getDate() - (presetDays[preset] - 1));
  return { from: toInputValue(from), to: toInputValue(to) };
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : numberFormat.format(value);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatTimeSpan(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${round(value)} мс`;

  const seconds = value / 1000;
  if (seconds < 60) return `${round(seconds)} с`;

  const minutes = seconds / 60;
  if (minutes < 60) return `${round(minutes)} мин`;

  const hours = minutes / 60;
  if (hours < 24) return `${round(hours)} ч`;

  return `${round(hours / 24)} дн`;
}

function formatDuration(value: number | null): string {
  return formatTimeSpan(value);
}

function formatInterval(value: number | null): string {
  return formatTimeSpan(value);
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "—";
  }

  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} (${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())})`;
}

function formatDateTimeParts(value: string | null): { date: string; time: string } {
  if (!value) {
    return { date: "—", time: "" };
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return { date: "—", time: "" };
  }

  return {
    date: `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

function normalizeEscapedFallback(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function decodeEscapedText(value: string): string {
  try {
    return JSON.parse(
      `"${value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")}"`,
    );
  } catch {
    return normalizeEscapedFallback(value);
  }
}

function formatPreview(value: string | null): string {
  if (!value || value.trim() === "") {
    return "Нет данных";
  }

  const normalized = value.trim();

  try {
    const parsed = JSON.parse(normalized) as unknown;

    if (typeof parsed === "string") {
      return decodeEscapedText(parsed);
    }

    return JSON.stringify(parsed, null, 2);
  } catch {
    const relaxed = normalizeEscapedFallback(normalized);

    try {
      const reparsed = JSON.parse(relaxed) as unknown;

      if (typeof reparsed === "string") {
        return decodeEscapedText(reparsed);
      }

      return JSON.stringify(reparsed, null, 2);
    } catch {
      return relaxed;
    }
  }
}

function formatUrlForDisplay(value: string | null): string {
  if (!value) {
    return "—";
  }

  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function getResultLabel(value: string): string {
  return resultLabels[value] ?? value;
}

function getOutcomeLabel(value: string): string {
  return outcomeLabels[value] ?? value;
}

function getProviderLabel(value: string): string {
  return providerLabels[value] ?? value;
}

function getStatusLabel(value: string): string {
  return sourceStatusLabels[value] ?? value;
}

function getIntervalLabel(value: string): string {
  return intervalLabels[value] ?? value;
}

function getCleanupModeDescription(mode: HistoryCleanupMode, beforeLabel: string): string {
  if (mode === "archive") {
    return `Переместит файлы до ${beforeLabel} в архив. Текущий день и недавно изменённые файлы будут пропущены.`;
  }

  if (mode === "delete") {
    return `Безвозвратно удалит файлы до ${beforeLabel}. Текущий день и недавно изменённые файлы будут пропущены.`;
  }

  return "Удалит все старые log-файлы выбранных источников и очистит архив. Текущий день и недавно изменённые файлы будут пропущены.";
}

function getCleanupActionLabel(action: HistoryCleanupResult["files"][number]["action"]): string {
  return action === "archived" ? "Архивирован" : "Удалён";
}

function getCleanupActionTone(action: HistoryCleanupResult["files"][number]["action"]): string {
  return action === "archived" ? "is-positive" : "is-negative";
}

function getLogControlLabel(enabled: boolean | null): string {
  if (enabled === true) return "Логи включены";
  if (enabled === false) return "Логи выключены";
  return "Статус неизвестен";
}

function getLogControlTone(enabled: boolean | null): string {
  if (enabled === true) return "is-positive";
  if (enabled === false) return "is-warning";
  return "is-negative";
}

function isOutcomeRedundant(result: string, outcome: string): boolean {
  return (
    (result === "positive" && (outcome === "positive" || outcome === "success")) ||
    (result === "negative" && outcome === "negative") ||
    (result === "unknown" && outcome === "unknown")
  );
}

function toneClass(value: string): string {
  if (value === "positive" || value === "ok" || value === "success") return "is-positive";
  if (value === "negative" || value === "missing" || value === "application_error" || value === "http_error") return "is-negative";
  return "is-warning";
}

function buildPageItems(currentPage: number, totalPages: number): Array<number | string> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (currentPage <= 4) return [1, 2, 3, 4, 5, "...", totalPages];
  if (currentPage >= totalPages - 3) return [1, "...", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  return [1, "...", currentPage - 1, currentPage, currentPage + 1, "...", totalPages];
}

function Panel(props: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode; tall?: boolean }) {
  return (
    <section className={`panel${props.tall ? " panel-tall" : ""}`}>
      <header className="panel-header">
        <div>
          <h2>{props.title}</h2>
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </div>
        {props.actions ? <div className="panel-actions">{props.actions}</div> : null}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

function MetricCard(props: { label: string; value: ReactNode; note: string; compact?: boolean }) {
  return (
    <article className="metric-card">
      <span className="metric-label">{props.label}</span>
      <div className={`metric-value${props.compact ? " is-compact" : ""}`}>{props.value}</div>
      <span className="metric-note">{props.note}</span>
    </article>
  );
}

function EmptyState(props: { text: string }) {
  return <div className="empty-chart">{props.text}</div>;
}

export default function App() {
  const [preset, setPreset] = useState<RangePreset | "custom">("24h");
  const [range, setRange] = useState(() => presetToRange("24h"));
  const [source, setSource] = useState("all");
  const [provider, setProvider] = useState("all");
  const [result, setResult] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const [recentPage, setRecentPage] = useState(1);
  const [recentPageSize, setRecentPageSize] = useState(15);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<RecentRequest | null>(null);
  const [requestDetails, setRequestDetails] = useState<RequestDetailsPayload | null>(null);
  const [requestDetailsLoading, setRequestDetailsLoading] = useState(false);
  const [requestDetailsError, setRequestDetailsError] = useState<string | null>(null);
  const [showFullRequest, setShowFullRequest] = useState(false);
  const [showFullResponse, setShowFullResponse] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [cleanupMode, setCleanupMode] = useState<HistoryCleanupMode>("archive");
  const [archiveMessage, setArchiveMessage] = useState<string | null>(null);
  const [cleanupResult, setCleanupResult] = useState<HistoryCleanupResult | null>(null);
  const [controlMessage, setControlMessage] = useState<string | null>(null);
  const [sourceControlBusy, setSourceControlBusy] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRecentPage(1);
  }, [range.from, range.to, source, provider, result, outcome, search]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const fromDate = new Date(range.from);
        const toDate = new Date(range.to);
        const payload = await fetchDashboard({
          from: Number.isFinite(fromDate.getTime()) ? fromDate.toISOString() : undefined,
          to: Number.isFinite(toDate.getTime()) ? toDate.toISOString() : undefined,
          source,
          provider,
          result,
          outcome,
          search,
          recentPage,
          recentPageSize,
        });
        if (!active) return;
        setDashboard(payload);
        setError(null);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить данные");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [outcome, provider, range.from, range.to, recentPage, recentPageSize, refreshTick, result, search, source]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => {
      setRefreshTick((value) => value + 1);
    }, dashboard?.system.refreshIntervalMs ?? 30000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, dashboard?.system.refreshIntervalMs]);

  useEffect(() => {
    if (!selectedRequest) {
      setRequestDetails(null);
      setRequestDetailsError(null);
      setRequestDetailsLoading(false);
      setShowFullRequest(false);
      setShowFullResponse(false);
      return;
    }

    let active = true;
    const requestId = selectedRequest.id;
    setRequestDetails(null);
    setRequestDetailsError(null);
    setRequestDetailsLoading(true);
    setShowFullRequest(false);
    setShowFullResponse(false);

    async function loadDetails() {
      try {
        const payload = await fetchRequestDetails(requestId);
        if (!active) return;
        setRequestDetails(payload);
      } catch (detailsError) {
        if (!active) return;
        setRequestDetailsError(detailsError instanceof Error ? detailsError.message : "Не удалось загрузить детали запроса");
      } finally {
        if (active) setRequestDetailsLoading(false);
      }
    }

    void loadDetails();

    return () => {
      active = false;
    };
  }, [selectedRequest]);

  function applyPreset(nextPreset: RangePreset) {
    setPreset(nextPreset);
    setRange(presetToRange(nextPreset));
  }

  function handleRangeChange(key: "from" | "to", value: string) {
    setPreset("custom");
    setRange((current) => ({ ...current, [key]: normalizeRangeValue(value, key === "from" ? "start" : "end") }));
  }

  function openRequestModal(request: RecentRequest) {
    setSelectedRequest(request);
  }

  function closeRequestModal() {
    setSelectedRequest(null);
  }

  async function handleArchiveHistory() {
    const beforeDate = new Date(range.to);
    const beforeIso = Number.isFinite(beforeDate.getTime()) ? beforeDate.toISOString() : new Date().toISOString();
    const sourceIds = source === "all" ? [] : [source];
    try {
      setArchiveBusy(true);
      const payload = await cleanupHistory(beforeIso, sourceIds, cleanupMode);
      const modeLabel = cleanupModeLabels[payload.mode];
      setArchiveMessage(
        `${modeLabel}: обработано ${payload.affectedFiles}, архивировано ${payload.archivedFiles}, удалено ${payload.deletedFiles}, пропущено ${payload.skippedFiles}. ` +
          `Текущие и недавно изменённые файлы не затрагиваются.`,
      );
      setCleanupResult(payload);
      setArchiveModalOpen(false);
      setRecentPage(1);
      setRefreshTick((value) => value + 1);
      setError(null);
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "Не удалось очистить историю");
    } finally {
      setArchiveBusy(false);
    }
  }

  async function handleSourceLoggingToggle(sourceItem: SourceActivityItem) {
    if (!sourceItem.logControl.supported || sourceItem.logControl.enabled === null) {
      return;
    }

    const nextEnabled = !sourceItem.logControl.enabled;

    try {
      setSourceControlBusy((current) => ({ ...current, [sourceItem.id]: true }));
      const payload = await updateSourceLogging(sourceItem.id, nextEnabled);
      setControlMessage(payload.message);
      setError(null);
      setRefreshTick((value) => value + 1);
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : "Не удалось изменить состояние логирования");
    } finally {
      setSourceControlBusy((current) => ({ ...current, [sourceItem.id]: false }));
    }
  }

  const timeline = dashboard?.charts.timeline ?? [];
  const outcomeData = (dashboard?.charts.outcomes ?? []).map((item) => ({ ...item, label: getOutcomeLabel(item.key) }));
  const providerData = (dashboard?.charts.providers ?? []).map((item) => ({ ...item, label: getProviderLabel(item.key) }));
  const sourceData = dashboard?.charts.sources ?? [];
  const statusData = dashboard?.charts.statusCodes ?? [];
  const endpointData = dashboard?.charts.endpoints ?? [];
  const hourData = dashboard?.charts.hours ?? [];
  const recentPagination = dashboard?.tables.recentRequests ?? { page: 1, pageSize: recentPageSize, total: 0, totalPages: 1, items: [] as RecentRequest[] };
  const recentRequests = recentPagination.items;
  const sourceActivity = dashboard?.tables.sourceActivity ?? [];
  const endpointMaxCount = Math.max(...endpointData.map((item) => item.count), 1);
  const pageItems = buildPageItems(recentPagination.page, recentPagination.totalPages);
  const selectedSourcesText =
    source === "all" ? `все источники (${dashboard?.options.sources.length ?? 0})` : dashboard?.options.sources.find((item) => item.value === source)?.label ?? source;
  const archiveBeforeDate = new Date(range.to);
  const archiveBeforeLabel = Number.isFinite(archiveBeforeDate.getTime()) ? formatDateTime(archiveBeforeDate.toISOString()) : "текущего времени";
  const cleanupModeDescription = getCleanupModeDescription(cleanupMode, archiveBeforeLabel);
  const requestPreviewText = formatPreview(requestDetails?.requestPreview ?? selectedRequest?.requestPreview ?? null);
  const responsePreviewText = formatPreview(requestDetails?.responsePreview ?? selectedRequest?.responsePreview ?? null);
  const requestFullText = formatPreview(requestDetails?.requestBody ?? requestDetails?.requestPreview ?? selectedRequest?.requestPreview ?? null);
  const responseFullText = formatPreview(requestDetails?.responseBody ?? requestDetails?.responsePreview ?? selectedRequest?.responsePreview ?? null);
  const canShowFullRequest = Boolean(requestDetails?.requestBody);
  const canShowFullResponse = Boolean(requestDetails?.responseBody);
  const selectedRequestHasDistinctOutcome = selectedRequest ? !isOutcomeRedundant(selectedRequest.result, selectedRequest.outcome) : false;
  const latestRequestParts = formatDateTimeParts(dashboard?.summary.latestTimestamp ?? null);

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">HTTP analytics</span>
          <h1>Панель аналитики HTTP</h1>
          <p>
            Единая панель по логам ваших сервисов: сколько запросов ушло, чем они закончились, какие endpoint&apos;ы
            нагружены сильнее всего и где начали появляться ошибки.
          </p>
        </div>

        <div className="hero-meta">
          <div>
            <span className="meta-label">Последнее обновление</span>
            <strong>{formatDateTime(dashboard?.system.lastRefreshAt ?? null)}</strong>
          </div>
          <div>
            <span className="meta-label">Проиндексировано файлов</span>
            <strong>{formatNumber(dashboard?.system.totalIndexedFiles ?? 0)}</strong>
          </div>
          <div>
            <span className="meta-label">Проиндексировано запросов</span>
            <strong>{formatNumber(dashboard?.system.totalIndexedRequests ?? 0)}</strong>
          </div>
          <div>
            <span className="meta-label">Источники в выборке</span>
            <strong>{selectedSourcesText}</strong>
          </div>
        </div>
      </section>

      <section className="toolbar">
        <div className="toolbar-head">
          <div className="preset-group">
            {(["24h", "7d", "30d", "90d"] as RangePreset[]).map((item) => (
              <button
                key={item}
                type="button"
                className={`preset-button${preset === item ? " is-active" : ""}`}
                onClick={() => applyPreset(item)}
              >
                {presetLabels[item]}
              </button>
            ))}
          </div>

          <div className="toolbar-actions">
            <label className="toggle toggle-inline">
              <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
              <span>Автообновление</span>
            </label>
            <button type="button" className="secondary-button" onClick={() => setRefreshTick((value) => value + 1)}>
              Обновить сейчас
            </button>
            <button type="button" className="danger-button" onClick={() => setArchiveModalOpen(true)}>
              Очистить историю
            </button>
          </div>
        </div>

        <div className="filters-grid">
          <label>
            <span>От</span>
            <input type="datetime-local" step={1} value={range.from} onChange={(event) => handleRangeChange("from", event.target.value)} />
          </label>

          <label>
            <span>До</span>
            <input type="datetime-local" step={1} value={range.to} onChange={(event) => handleRangeChange("to", event.target.value)} />
          </label>

          <label>
            <span>Источник</span>
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="all">Все источники</option>
              {dashboard?.options.sources.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label} ({numberFormat.format(item.count)})
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Провайдер</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="all">Все провайдеры</option>
              {dashboard?.options.providers.map((item) => (
                <option key={item.value} value={item.value}>
                  {getProviderLabel(item.label)} ({numberFormat.format(item.count)})
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Результат</span>
            <select value={result} onChange={(event) => setResult(event.target.value)}>
              <option value="all">Все</option>
              <option value="positive">Успешно</option>
              <option value="negative">С ошибкой</option>
              <option value="unknown">Не определено</option>
            </select>
          </label>

          <label>
            <span>Исход</span>
            <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
              <option value="all">Все</option>
              {dashboard?.options.outcomes.map((item) => (
                <option key={item.value} value={item.value}>
                  {getOutcomeLabel(item.label)} ({numberFormat.format(item.count)})
                </option>
              ))}
            </select>
          </label>

          <label className="search-field">
            <span>Поиск</span>
            <input
              type="search"
              placeholder="URL, endpoint, ошибка"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>

        <div className="info-row">
          {archiveMessage ? (
            <div className="info-banner cleanup-banner">
              <p className="cleanup-banner-summary">{archiveMessage}</p>
              {cleanupResult ? (
                cleanupResult.files.length > 0 ? (
                  <div className="cleanup-files-list">
                    {cleanupResult.files.map((item) => (
                      <article
                        key={`${item.action}:${item.filePath}:${item.destinationPath ?? "none"}`}
                        className="cleanup-file-item"
                      >
                        <div className="cleanup-file-head">
                          <span className={`pill ${getCleanupActionTone(item.action)}`}>{getCleanupActionLabel(item.action)}</span>
                          <strong>{item.sourceName}</strong>
                        </div>
                        <code className="cleanup-file-path">{item.filePath}</code>
                        <span className="cleanup-file-note">
                          {item.action === "archived" && item.destinationPath
                            ? `Перемещён в ${item.destinationPath}`
                            : "Удалён без архива"}
                        </span>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="cleanup-banner-empty">Подходящих файлов для обработки не нашлось.</p>
                )
              ) : null}
            </div>
          ) : null}
          {controlMessage ? <div className="info-banner">{controlMessage}</div> : null}
          {error ? <div className="error-banner">{error}</div> : null}
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard
          label="Запросов в диапазоне"
          value={formatNumber(dashboard?.summary.totalRequests ?? 0)}
          note={`Из ${formatNumber(dashboard?.system.totalIndexedRequests ?? 0)} проиндексированных`}
        />
        <MetricCard
          label="Успешно"
          value={formatNumber(dashboard?.summary.positiveRequests ?? 0)}
          note={`${dashboard?.summary.successRate ?? 0}% от выборки`}
        />
        <MetricCard
          label="С ошибкой"
          value={formatNumber(dashboard?.summary.negativeRequests ?? 0)}
          note={`Неопределённых: ${formatNumber(dashboard?.summary.unknownRequests ?? 0)}`}
        />
        <MetricCard
          label="Средняя длительность"
          value={formatDuration(dashboard?.summary.avgDurationMs ?? null)}
          note={`P95: ${formatDuration(dashboard?.summary.p95DurationMs ?? null)}`}
        />
        <MetricCard
          label="Максимальная длительность"
          value={formatDuration(dashboard?.summary.maxDurationMs ?? null)}
          note={`Endpoint'ов: ${formatNumber(dashboard?.summary.uniqueEndpoints ?? 0)}`}
        />
        <MetricCard
          label="Средний интервал"
          value={formatInterval(dashboard?.summary.avgGapMs ?? null)}
          note={`P95: ${formatInterval(dashboard?.summary.p95GapMs ?? null)} • Макс: ${formatInterval(dashboard?.summary.maxGapMs ?? null)}`}
        />
        <MetricCard
          label="Последний запрос"
          compact
          value={
            <>
              <span className="metric-value-line">{latestRequestParts.date}</span>
              {latestRequestParts.time ? <span className="metric-value-line metric-value-time">{latestRequestParts.time}</span> : null}
            </>
          }
          note={`Провайдеров: ${formatNumber(dashboard?.summary.uniqueProviders ?? 0)}`}
        />
      </section>

      <section className="layout-grid">
        <Panel title="Таймлайн" subtitle={`Группировка: ${getIntervalLabel(dashboard?.filters.interval ?? "day")}`} tall>
          {timeline.length === 0 ? (
            <EmptyState text="В этом диапазоне нет данных" />
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={timeline} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148, 163, 184, 0.28)" />
                <XAxis dataKey="bucket" tick={{ fill: "#486581", fontSize: 12 }} />
                <YAxis tick={{ fill: "#486581", fontSize: 12 }} allowDecimals={false} />
                <Tooltip />
                <Legend formatter={(value) => getResultLabel(String(value))} />
                <Area type="monotone" dataKey="total" name="total" stroke="#0f172a" fill="#0f172a" fillOpacity={0.08} />
                <Area
                  type="monotone"
                  dataKey="positive"
                  name="positive"
                  stroke="#0f766e"
                  fill="#0f766e"
                  fillOpacity={0.18}
                />
                <Area
                  type="monotone"
                  dataKey="negative"
                  name="negative"
                  stroke="#dc2626"
                  fill="#dc2626"
                  fillOpacity={0.12}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Исходы" subtitle="Каким результатом заканчиваются запросы" tall>
          {outcomeData.length === 0 ? (
            <EmptyState text="Нет данных для распределения" />
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <PieChart>
                <Pie
                  data={outcomeData}
                  dataKey="count"
                  nameKey="label"
                  innerRadius={72}
                  outerRadius={110}
                  paddingAngle={2}
                >
                  {outcomeData.map((item, index) => (
                    <Cell key={item.key} fill={outcomeColors[index % outcomeColors.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Провайдеры" subtitle="По каким провайдерам больше всего вызовов">
          {providerData.length === 0 ? (
            <EmptyState text="Нет данных по провайдерам" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={providerData} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148, 163, 184, 0.28)" />
                <XAxis dataKey="label" tick={{ fill: "#486581", fontSize: 12 }} />
                <YAxis tick={{ fill: "#486581", fontSize: 12 }} allowDecimals={false} />
                <Tooltip />
                <Legend formatter={(value) => getResultLabel(String(value))} />
                <Bar dataKey="count" name="total" fill="#0f172a" radius={[10, 10, 0, 0]} />
                <Bar dataKey="positive" name="positive" fill="#0f766e" radius={[10, 10, 0, 0]} />
                <Bar dataKey="negative" name="negative" fill="#dc2626" radius={[10, 10, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Источники" subtitle="Нагрузка по проектам и сервисам">
          {sourceData.length === 0 ? (
            <EmptyState text="Нет данных по источникам" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={sourceData} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148, 163, 184, 0.28)" />
                <XAxis dataKey="key" tick={{ fill: "#486581", fontSize: 12 }} />
                <YAxis tick={{ fill: "#486581", fontSize: 12 }} allowDecimals={false} />
                <Tooltip />
                <Legend formatter={(value) => getResultLabel(String(value))} />
                <Bar dataKey="count" name="total" fill="#0f172a" radius={[10, 10, 0, 0]} />
                <Bar dataKey="positive" name="positive" fill="#0f766e" radius={[10, 10, 0, 0]} />
                <Bar dataKey="negative" name="negative" fill="#dc2626" radius={[10, 10, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Распределение по часам" subtitle="Когда отправляется больше всего запросов">
          {hourData.length === 0 ? (
            <EmptyState text="Нет данных по часам" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={hourData} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148, 163, 184, 0.28)" />
                <XAxis dataKey="key" tick={{ fill: "#486581", fontSize: 12 }} />
                <YAxis tick={{ fill: "#486581", fontSize: 12 }} allowDecimals={false} />
                <Tooltip />
                <Legend formatter={(value) => getResultLabel(String(value))} />
                <Bar dataKey="total" name="total" fill="#0f172a" radius={[10, 10, 0, 0]} />
                <Bar dataKey="positive" name="positive" fill="#0f766e" radius={[10, 10, 0, 0]} />
                <Bar dataKey="negative" name="negative" fill="#dc2626" radius={[10, 10, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="HTTP статусы" subtitle="Какие коды ответа возвращаются чаще всего">
          {statusData.length === 0 ? (
            <EmptyState text="Нет данных по HTTP статусам" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={statusData} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148, 163, 184, 0.28)" />
                <XAxis dataKey="key" tick={{ fill: "#486581", fontSize: 12 }} />
                <YAxis tick={{ fill: "#486581", fontSize: 12 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" fill="#155e75" radius={[10, 10, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </section>

      <Panel title="Топ endpoint'ов" subtitle="Какие endpoint'ы чаще всего встречаются и где больше ошибок" tall>
        {endpointData.length === 0 ? (
          <EmptyState text="Нет данных по endpoint'ам" />
        ) : (
          <div className="endpoint-list">
            {endpointData.map((item) => {
              const share = Math.round((item.count / endpointMaxCount) * 100);
              const successRate = item.count === 0 ? 0 : Math.round((item.positive / item.count) * 100);
              const platformText =
                item.platforms.length === 0
                  ? "Платформа не определена"
                  : item.platforms.map((platform) => `${getProviderLabel(platform.key)} (${formatNumber(platform.count)})`).join(" • ");

              return (
                <article key={item.key} className="endpoint-card">
                  <div className="endpoint-main">
                    <div>
                      <h3>{item.key}</h3>
                      <p className="endpoint-platforms">Платформы: {platformText}</p>
                      <p>
                        Всего: {formatNumber(item.count)} • Успешно: {formatNumber(item.positive)} • С ошибкой:{" "}
                        {formatNumber(item.negative)}
                      </p>
                    </div>
                    <div className="endpoint-metrics">
                      <strong>{formatNumber(item.count)}</strong>
                      <span>запросов</span>
                    </div>
                  </div>

                  <div className="endpoint-progress">
                    <div className="endpoint-bar">
                      <span className="endpoint-bar-fill" style={{ width: `${share}%` }} />
                    </div>
                    <span>{share}% от лидера</span>
                  </div>

                  <div className="endpoint-foot">
                    <span>Доля успешных: {successRate}%</span>
                    <span>Средняя длительность: {formatDuration(item.avgDurationMs)}</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="Состояние источников" subtitle="Что происходит по каждому подключённому проекту">
        {sourceActivity.length === 0 ? (
          <EmptyState text="Источники пока не обнаружены" />
        ) : (
          <div className="source-grid">
            {sourceActivity.map((item) => (
              <article key={item.id} className="source-card">
                <div className="source-head">
                  <strong>{item.name}</strong>
                  <span className={`pill ${toneClass(item.status)}`}>{getStatusLabel(item.status)}</span>
                </div>
                <div className="source-stats">
                  <span>Файлов: {formatNumber(item.discoveredFiles)}</span>
                  <span>Всего записей: {formatNumber(item.totalEntries)}</span>
                  <span>В выборке: {formatNumber(item.filteredEntries)}</span>
                </div>
                <div className="source-foot">
                  <span>Последнее событие: {formatDateTime(item.lastEventAt)}</span>
                </div>
                <div className="source-control">
                  <div className="source-control-head">
                    <span className={`pill ${getLogControlTone(item.logControl.enabled)}`}>{getLogControlLabel(item.logControl.enabled)}</span>
                    <button
                      type="button"
                      className="secondary-button source-control-button"
                      disabled={!item.logControl.supported || sourceControlBusy[item.id] || item.logControl.enabled === null}
                      onClick={() => void handleSourceLoggingToggle(item)}
                    >
                      {sourceControlBusy[item.id]
                        ? "Применяю..."
                        : item.logControl.enabled
                          ? "Выключить логи"
                          : "Включить логи"}
                    </button>
                  </div>
                  <p className="source-control-note">{item.logControl.note ?? item.logControl.error ?? "Управление логированием недоступно."}</p>
                </div>
                {item.issue ? <p className="source-issue">{item.issue}</p> : null}
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Последние запросы"
        subtitle="По умолчанию показываются 15 последних запросов. Любую строку можно открыть в модалке."
        actions={
          <div className="table-controls">
            <label>
              <span>Показывать</span>
              <select
                value={recentPageSize}
                onChange={(event) => {
                  setRecentPageSize(Number(event.target.value));
                  setRecentPage(1);
                }}
              >
                <option value={15}>15</option>
                <option value={30}>30</option>
                <option value={50}>50</option>
              </select>
            </label>
            <span className="table-summary">
              Всего: {formatNumber(recentPagination.total)} • Страница {recentPagination.page} из {recentPagination.totalPages}
            </span>
          </div>
        }
      >
        {recentRequests.length === 0 ? (
          <EmptyState text="Нет запросов для выбранного диапазона" />
        ) : (
          <>
            <div className="table-wrap">
              <table className="requests-table">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Источник</th>
                    <th>Провайдер</th>
                    <th>Endpoint</th>
                    <th>Результат</th>
                    <th>HTTP</th>
                    <th>Длительность</th>
                    <th>Интервал</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {recentRequests.map((item) => (
                    <tr key={item.id} onClick={() => openRequestModal(item)}>
                      <td>{formatDateTime(item.timestamp)}</td>
                      <td>{item.sourceName}</td>
                      <td>{getProviderLabel(item.provider)}</td>
                      <td className="mono-cell">
                        {item.method} {item.operation}
                      </td>
                      <td>
                        <div className="request-result">
                          <span className={`pill ${toneClass(item.result)}`}>{getResultLabel(item.result)}</span>
                          {!isOutcomeRedundant(item.result, item.outcome) ? (
                            <span className={`pill ${toneClass(item.outcome)}`}>{getOutcomeLabel(item.outcome)}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>{item.statusCode ?? "—"}</td>
                      <td>{formatDuration(item.durationMs)}</td>
                      <td>{formatInterval(item.gapSincePreviousMs)}</td>
                      <td>
                        <button
                          type="button"
                          className="inline-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openRequestModal(item);
                          }}
                        >
                          Открыть
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pagination">
              <button
                type="button"
                className="pagination-button"
                disabled={recentPagination.page <= 1}
                onClick={() => setRecentPage((value) => Math.max(1, value - 1))}
              >
                Назад
              </button>

              {pageItems.map((item, index) =>
                typeof item === "string" ? (
                  <span key={`dots-${index}`} className="pagination-dots">
                    {item}
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    className={`pagination-button${item === recentPagination.page ? " is-active" : ""}`}
                    onClick={() => setRecentPage(item)}
                  >
                    {item}
                  </button>
                ),
              )}

              <button
                type="button"
                className="pagination-button"
                disabled={recentPagination.page >= recentPagination.totalPages}
                onClick={() => setRecentPage((value) => Math.min(recentPagination.totalPages, value + 1))}
              >
                Вперёд
              </button>
            </div>
          </>
        )}
      </Panel>

      {selectedRequest ? (
        <div className="modal-backdrop" onClick={() => closeRequestModal()}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>Детали запроса</h3>
                <p>
                  {selectedRequest.method} {selectedRequest.operation}
                </p>
              </div>
              <button type="button" className="icon-button" onClick={() => closeRequestModal()}>
                Закрыть
              </button>
            </div>

            <div className="modal-grid">
              <div className="modal-meta">
                <span className="details-label">Время</span>
                <strong>{formatDateTime(selectedRequest.timestamp)}</strong>
              </div>
              <div className="modal-meta">
                <span className="details-label">Источник</span>
                <strong>{selectedRequest.sourceName}</strong>
              </div>
              <div className="modal-meta">
                <span className="details-label">Провайдер</span>
                <strong>{getProviderLabel(selectedRequest.provider)}</strong>
              </div>
              <div className="modal-meta">
                <span className="details-label">HTTP статус</span>
                <strong>{selectedRequest.statusCode ?? "—"}</strong>
              </div>
              <div className="modal-meta">
                <span className="details-label">Результат</span>
                <strong>{getResultLabel(selectedRequest.result)}</strong>
              </div>
              {selectedRequestHasDistinctOutcome ? (
                <div className="modal-meta">
                  <span className="details-label">Исход</span>
                  <strong>{getOutcomeLabel(selectedRequest.outcome)}</strong>
                </div>
              ) : null}
              <div className="modal-meta">
                <span className="details-label">Длительность</span>
                <strong>{formatDuration(selectedRequest.durationMs)}</strong>
              </div>
              <div className="modal-meta">
                <span className="details-label">Интервал до прошлого</span>
                <strong>{formatInterval(selectedRequest.gapSincePreviousMs)}</strong>
              </div>
              <div className="modal-meta modal-meta-wide">
                <span className="details-label">URL</span>
                <strong className="url-value">{formatUrlForDisplay(selectedRequest.url)}</strong>
              </div>
            </div>

            <div className="details-stack">
              {selectedRequest.error ? (
                <div className="modal-block">
                  <span className="details-label">Ошибка</span>
                  <p className="details-error">{selectedRequest.error}</p>
                </div>
              ) : null}

              <div className="modal-block">
                <div className="modal-block-header">
                  <span className="details-label">Тело запроса</span>
                  <div className="detail-actions">
                    <button
                      type="button"
                      className={`detail-toggle${!showFullRequest ? " is-active" : ""}`}
                      onClick={() => setShowFullRequest(false)}
                    >
                      Превью
                    </button>
                    <button
                      type="button"
                      className={`detail-toggle${showFullRequest ? " is-active" : ""}`}
                      disabled={!canShowFullRequest || requestDetailsLoading}
                      onClick={() => setShowFullRequest(true)}
                    >
                      Полный запрос
                    </button>
                  </div>
                </div>
                {requestDetailsLoading ? <div className="details-note">Загружаю полное тело запроса...</div> : null}
                {!requestDetailsLoading && requestDetailsError ? <div className="details-note is-error">{requestDetailsError}</div> : null}
                {!requestDetailsLoading && showFullRequest && requestDetails && !requestDetails.requestBodyComplete ? (
                  <div className="details-note">В этом источнике в лог попало только превью запроса.</div>
                ) : null}
                <pre className="preview-content">{showFullRequest ? requestFullText : requestPreviewText}</pre>
              </div>

              <div className="modal-block">
                <div className="modal-block-header">
                  <span className="details-label">Тело ответа</span>
                  <div className="detail-actions">
                    <button
                      type="button"
                      className={`detail-toggle${!showFullResponse ? " is-active" : ""}`}
                      onClick={() => setShowFullResponse(false)}
                    >
                      Превью
                    </button>
                    <button
                      type="button"
                      className={`detail-toggle${showFullResponse ? " is-active" : ""}`}
                      disabled={!canShowFullResponse || requestDetailsLoading}
                      onClick={() => setShowFullResponse(true)}
                    >
                      Полный ответ
                    </button>
                  </div>
                </div>
                {requestDetailsLoading ? <div className="details-note">Загружаю полное тело ответа...</div> : null}
                {!requestDetailsLoading && requestDetailsError ? <div className="details-note is-error">{requestDetailsError}</div> : null}
                {!requestDetailsLoading && showFullResponse && requestDetails && !requestDetails.responseBodyComplete ? (
                  <div className="details-note">В этом источнике в лог попало только превью ответа.</div>
                ) : null}
                <pre className="preview-content">{showFullResponse ? responseFullText : responsePreviewText}</pre>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {archiveModalOpen ? (
        <div className="modal-backdrop" onClick={() => setArchiveModalOpen(false)}>
          <div className="modal-card modal-card-compact" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>Очистка истории</h3>
                <p>Выберите, что делать со старыми логами: архивировать, удалить или очистить историю полностью.</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setArchiveModalOpen(false)}>
                Закрыть
              </button>
            </div>

            <div className="details-stack">
              <div className="modal-block">
                <span className="details-label">Режим очистки</span>
                <div className="cleanup-mode-grid">
                  {(["archive", "delete", "full_clear"] as HistoryCleanupMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`cleanup-mode-button${cleanupMode === mode ? " is-active" : ""}${mode === "full_clear" ? " is-danger" : ""}`}
                      onClick={() => setCleanupMode(mode)}
                    >
                      <strong>{cleanupModeLabels[mode]}</strong>
                      <span>
                        {mode === "archive"
                          ? "Безопасный режим"
                          : mode === "delete"
                            ? "Удаление без архива"
                            : "Удалит старые логи и архив"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="modal-block">
                <span className="details-label">Что произойдёт</span>
                <p>{cleanupModeDescription}</p>
              </div>

              <div className="modal-block">
                <span className="details-label">Какие источники затронет</span>
                <p>{selectedSourcesText}</p>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="secondary-button" onClick={() => setArchiveModalOpen(false)}>
                Отмена
              </button>
              <button type="button" className="danger-button" disabled={archiveBusy} onClick={() => void handleArchiveHistory()}>
                {archiveBusy ? "Применяю..." : cleanupModeLabels[cleanupMode]}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {loading ? <div className="loading-state">Обновляю данные...</div> : null}
    </main>
  );
}
