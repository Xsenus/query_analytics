import "dotenv/config";

import { createApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";

const runtime = loadRuntimeConfig();
const app = createApp(runtime);

const server = app.listen(runtime.port, runtime.host, () => {
  console.log(`[query-analytics] listening on http://${runtime.host}:${runtime.port}`);
  console.log(`[query-analytics] sources config: ${runtime.sourcesConfigPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[query-analytics] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
