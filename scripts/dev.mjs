import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";

const ROOT = process.cwd();
const CLIENT_PORT = 5173;
const SERVER_PORT = 3030;

function colorize(message, colorCode) {
  return `\x1b[${colorCode}m${message}\x1b[0m`;
}

function prefixStream(stream, prefix, colorCode) {
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) {
        continue;
      }
      process.stdout.write(`${colorize(`[${prefix}]`, colorCode)} ${line}\n`);
    }
  });

  stream.on("end", () => {
    if (buffer) {
      process.stdout.write(`${colorize(`[${prefix}]`, colorCode)} ${buffer}\n`);
    }
  });
}

function startProcess(name, colorCode, command, args) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
    windowsHide: false,
  });

  if (child.stdout) {
    prefixStream(child.stdout, name, colorCode);
  }

  if (child.stderr) {
    prefixStream(child.stderr, name, colorCode);
  }

  child.on("error", (error) => {
    process.stderr.write(`${colorize(`[${name}]`, colorCode)} failed to start: ${error.message}\n`);
  });

  return child;
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

async function describePort(port) {
  const script = `
$connection = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $connection) { return }
$process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
[PSCustomObject]@{
  pid = $connection.OwningProcess
  processName = if ($process) { $process.ProcessName } else { "" }
  state = $connection.State
} | ConvertTo-Json -Compress
`;

  const output = await runPowerShell(script);
  if (!output) {
    return null;
  }

  return JSON.parse(output);
}

async function main() {
  const occupiedPorts = await Promise.all([
    describePort(SERVER_PORT).catch(() => null).then((occupant) => ({ port: SERVER_PORT, label: "Сервер", occupant })),
    describePort(CLIENT_PORT).catch(() => null).then((occupant) => ({ port: CLIENT_PORT, label: "Клиент", occupant })),
  ]);

  const conflicts = occupiedPorts.filter((item) => item.occupant);
  if (conflicts.length > 0) {
    for (const item of conflicts) {
      const processName = item.occupant.processName ? ` (${item.occupant.processName})` : "";
      process.stderr.write(
        `${item.label} не запущен: порт ${item.port} уже занят процессом PID ${item.occupant.pid}${processName}.\n`,
      );
    }

    process.stderr.write(
      "Освободите занятые порты или остановите предыдущий экземпляр приложения, затем повторите запуск.\n",
    );
    process.exit(1);
  }

  const server = startProcess("dev:server", "36", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "watch", "server/index.ts"]);
  const client = startProcess("dev:client", "32", process.execPath, ["./node_modules/vite/bin/vite.js"]);

  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (!server.killed) {
      server.kill(signal);
    }
    if (!client.killed) {
      client.kill(signal);
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const [exitedChild, exitCode, exitSignal] = await Promise.race([
    once(server, "exit").then((args) => ["server", ...args]),
    once(client, "exit").then((args) => ["client", ...args]),
  ]);

  shutdown("SIGTERM");

  if (exitSignal) {
    process.exit(1);
  }

  process.exit(exitCode ?? 0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
