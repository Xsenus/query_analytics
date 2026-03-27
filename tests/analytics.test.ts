import { describe, expect, it } from "vitest";

import { buildDashboardPayload } from "../server/analytics/aggregate.js";
import { parseLogContent } from "../server/analytics/parser.js";
import type { RuntimeConfig } from "../server/config.js";
import type { SourceState } from "../server/analytics/types.js";

const sourceGarage = {
  id: "garage",
  name: "Garage",
  rootPath: "C:/garage",
  include: ["logs/http-requests-*.jsonl"],
  format: "garage-jsonl" as const,
};

const sourceLegacy = {
  id: "legacy",
  name: "Legacy",
  rootPath: "C:/legacy",
  include: ["logs/request_analytics_*.log"],
  format: "request-analytics" as const,
};

const sourceDotnet = {
  id: "dotnet",
  name: "Dotnet",
  rootPath: "C:/dotnet",
  include: ["logs/http-requests-*.jsonl"],
  format: "dotnet-jsonl" as const,
};

const runtime: RuntimeConfig = {
  port: 3030,
  host: "0.0.0.0",
  refreshIntervalMs: 15_000,
  maxRecentRequests: 10,
  snippetLength: 120,
  sourcesConfigPath: "config/sources.local.json",
};

describe("parseLogContent", () => {
  it("parses garage jsonl entries", () => {
    const line =
      '{"timestamp":"2026-03-27T14:26:09.107+07:00","service":"bitrix24","request":{"method":"POST","url":"https://example.test/rest/1/secret/crm.deal.list","payload":{"filter":{"ID":1}}},"response":{"ok":true,"outcome":"success","status_code":200,"duration_ms":245.5,"content_length":1234,"body_preview":"{\\"result\\":true}"},"meta":{"bitrix_method":"crm.deal.list"}}';

    const parsed = parseLogContent(line, sourceGarage, "C:/garage/logs/http-requests-2026-03-27.jsonl", 120);

    expect(parsed.parseErrors).toBe(0);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.provider).toBe("BITRIX");
    expect(parsed.entries[0]?.operation).toBe("crm.deal.list");
    expect(parsed.entries[0]?.result).toBe("positive");
  });

  it("parses legacy python analytics entries", () => {
    const line =
      '{"timestamp":"2026-03-27T09:30:00.000+07:00","provider":"Bitrix24","operation":"crm.contact.add","http_method":"POST","url":"https://example.test/rest/1/secret/crm.contact.add","request":{"fields":{"NAME":"Alice"}},"response":{"error":"bad request"},"success":false,"outcome":"negative","http_status":400,"duration_ms":180.25,"error":"bad request"}';

    const parsed = parseLogContent(line, sourceLegacy, "C:/legacy/logs/request_analytics_2026-03-27.log", 120);

    expect(parsed.parseErrors).toBe(0);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.provider).toBe("BITRIX");
    expect(parsed.entries[0]?.statusCode).toBe(400);
    expect(parsed.entries[0]?.result).toBe("negative");
  });

  it("parses dotnet analytics entries", () => {
    const line =
      '{"timestamp":"2026-03-27T14:26:53.441+07:00","completedAt":"2026-03-27T14:26:53.599+07:00","destination":"ABCP","result":"negative","outcome":"application_error","method":"GET","url":"https://abcp.example.test/cp/payment/token?number=250275820","path":"/cp/payment/token","query":"number=250275820","statusCode":400,"durationMs":158,"requestBody":null,"requestBodyLength":null,"responseBody":"{\\"errorCode\\":4}","responseBodyLength":16,"applicationError":"There is no order debt"}';

    const parsed = parseLogContent(line, sourceDotnet, "C:/dotnet/logs/http-requests-2026-03-27.jsonl", 120);

    expect(parsed.parseErrors).toBe(0);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.provider).toBe("ABCP");
    expect(parsed.entries[0]?.operation).toBe("payment/token");
    expect(parsed.entries[0]?.error).toBe("There is no order debt");
  });
});

describe("buildDashboardPayload", () => {
  it("aggregates entries into summary and charts", () => {
    const garageEntries = parseLogContent(
      '{"timestamp":"2026-03-27T14:00:00.000+07:00","service":"abcp","request":{"method":"GET","url":"https://example.test/cp/order?number=1","payload":{"number":1}},"response":{"ok":true,"outcome":"success","status_code":200,"duration_ms":100,"content_length":10,"body_preview":"ok"}}',
      sourceGarage,
      "C:/garage/logs/http-requests-2026-03-27.jsonl",
      120,
    ).entries;

    const legacyEntries = parseLogContent(
      '{"timestamp":"2026-03-27T15:00:00.000+07:00","provider":"Bitrix24","operation":"crm.deal.update","http_method":"POST","url":"https://example.test/rest/1/secret/crm.deal.update","request":{"id":1},"response":{"error":"bad request"},"success":false,"outcome":"negative","http_status":400,"duration_ms":250,"error":"bad request"}',
      sourceLegacy,
      "C:/legacy/logs/request_analytics_2026-03-27.log",
      120,
    ).entries;

    const states: SourceState[] = [
      {
        id: "garage",
        name: "Garage",
        rootPath: "C:/garage",
        include: [],
        format: "garage-jsonl",
        discoveredFiles: 1,
        totalEntries: 1,
        lastEventAt: garageEntries[0]?.timestamp ?? null,
        status: "ok",
        issue: null,
      },
      {
        id: "legacy",
        name: "Legacy",
        rootPath: "C:/legacy",
        include: [],
        format: "request-analytics",
        discoveredFiles: 1,
        totalEntries: 1,
        lastEventAt: legacyEntries[0]?.timestamp ?? null,
        status: "ok",
        issue: null,
      },
    ];

    const payload = buildDashboardPayload(
      [...legacyEntries, ...garageEntries].sort((left, right) => right.unixMs - left.unixMs),
      states,
      {
        fromMs: Date.parse("2026-03-27T00:00:00.000Z"),
        toMs: Date.parse("2026-03-28T00:00:00.000Z"),
        sourceIds: [],
        provider: null,
        result: null,
        outcome: null,
        search: null,
        recentPage: 1,
        recentPageSize: 15,
      },
      runtime,
      "2026-03-27T16:00:00.000Z",
    );

    expect(payload.summary.totalRequests).toBe(2);
    expect(payload.summary.positiveRequests).toBe(1);
    expect(payload.summary.negativeRequests).toBe(1);
    expect(payload.charts.timeline).toHaveLength(2);
    expect(payload.tables.recentRequests.items).toHaveLength(2);
    expect(payload.options.providers[0]?.value).toBe("BITRIX");
  });
});
