import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readSourceLogControlState, updateSourceLogControl } from "../server/log-controls.js";
import type { LogSourceConfig } from "../server/config.js";

describe("log controls", () => {
  it("updates env-based logging flag", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "query-analytics-env-control-"));
    const envPath = path.join(tempDir, ".env");
    const source: LogSourceConfig = {
      id: "custom-env",
      name: "Custom env source",
      rootPath: tempDir,
      include: [],
      format: "auto",
      analyticsControl: {
        type: "env",
        key: "REQUEST_ANALYTICS_ENABLED",
        filePath: ".env",
        enabledValue: "1",
        disabledValue: "0",
        defaultEnabled: true,
        applyMode: "manual",
      },
    };

    await fs.writeFile(envPath, "FOO=bar\nREQUEST_ANALYTICS_ENABLED=1\n", "utf8");

    try {
      const initialState = await readSourceLogControlState(source);
      expect(initialState.supported).toBe(true);
      expect(initialState.enabled).toBe(true);

      const result = await updateSourceLogControl(source, false);
      const nextContent = await fs.readFile(envPath, "utf8");

      expect(result.enabled).toBe(false);
      expect(result.control.enabled).toBe(false);
      expect(nextContent).toContain("REQUEST_ANALYTICS_ENABLED=0");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updates json-based logging flag in all configured files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "query-analytics-json-control-"));
    const currentDir = path.join(tempDir, "current");
    const sharedDir = path.join(tempDir, "shared");
    const currentConfigPath = path.join(currentDir, "server_config.json");
    const sharedConfigPath = path.join(sharedDir, "server_config.json");
    const source: LogSourceConfig = {
      id: "custom-json",
      name: "Custom json source",
      rootPath: currentDir,
      include: [],
      format: "auto",
      analyticsControl: {
        type: "json",
        key: "RuntimeOptions.EnableHttpRequestAnalytics",
        filePath: "server_config.json",
        additionalFilePaths: ["../shared/server_config.json"],
        defaultEnabled: true,
        applyMode: "manual",
      },
    };

    await fs.mkdir(currentDir, { recursive: true });
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(
      currentConfigPath,
      JSON.stringify({ RuntimeOptions: { EnableHttpRequestAnalytics: true, OtherFlag: 1 } }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      sharedConfigPath,
      JSON.stringify({ RuntimeOptions: { EnableHttpRequestAnalytics: true } }, null, 2),
      "utf8",
    );

    try {
      const result = await updateSourceLogControl(source, false);
      const currentContent = JSON.parse(await fs.readFile(currentConfigPath, "utf8")) as { RuntimeOptions: { EnableHttpRequestAnalytics: boolean } };
      const sharedContent = JSON.parse(await fs.readFile(sharedConfigPath, "utf8")) as { RuntimeOptions: { EnableHttpRequestAnalytics: boolean } };

      expect(result.enabled).toBe(false);
      expect(result.control.enabled).toBe(false);
      expect(currentContent.RuntimeOptions.EnableHttpRequestAnalytics).toBe(false);
      expect(sharedContent.RuntimeOptions.EnableHttpRequestAnalytics).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
