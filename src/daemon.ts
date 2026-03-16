// Workaround: The Copilot CLI gates windowsHide on `"type" in process`, which
// is only true in Electron. Setting this before the SDK loads causes MCP server
// spawns to use windowsHide, preventing console window flashes on Windows.
if (process.platform === "win32" && !("type" in process)) {
  (process as any).type = "browser";
}

import { getClient, stopClient } from "./copilot/client.js";
import { initOrchestrator, setMessageLogger, setProactiveNotify, getWorkers } from "./copilot/orchestrator.js";
import { startApiServer, broadcastToSSE } from "./api/server.js";
import { createBot, startBot, stopBot, sendProactiveMessage } from "./telegram/bot.js";
import { getDb, closeDb } from "./store/db.js";
import { config } from "./config.js";
import { spawn } from "child_process";
import { statSync } from "fs";
import { checkForUpdate } from "./update.js";
import { getEffectiveIdentity, LOG_PREFIX, PRIMARY_RUNTIME_ENV } from "./identity.js";

function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

async function main(): Promise<void> {
  const identity = getEffectiveIdentity();
  console.log(`${LOG_PREFIX} Starting ${identity.productName} daemon...`);

  // Apply workfolder if configured
  if (config.workfolder) {
    try {
      const stat = statSync(config.workfolder);
      if (stat.isDirectory()) {
        process.chdir(config.workfolder);
        console.log(`${LOG_PREFIX} Working directory: ${config.workfolder}`);
      } else {
        console.log(`${LOG_PREFIX} ⚠ ATTACHE_WORKFOLDER is not a directory: ${config.workfolder}`);
      }
    } catch {
      console.log(`${LOG_PREFIX} ⚠ ATTACHE_WORKFOLDER does not exist: ${config.workfolder}`);
    }
  }

  if (config.selfEditEnabled) {
    console.log(`${LOG_PREFIX} ⚠ Self-edit mode enabled — ${identity.productName} can modify its own source code`);
  }

  // Set up message logging to daemon console
  setMessageLogger((direction, source, text) => {
    const arrow = direction === "in" ? "⟶" : "⟵";
    const tag = source.padEnd(8);
    console.log(`${LOG_PREFIX} ${tag} ${arrow}  ${truncate(text)}`);
  });

  // Initialize SQLite
  getDb();
  console.log(`${LOG_PREFIX} Database initialized`);

  // Start Copilot SDK client
  console.log(`${LOG_PREFIX} Starting Copilot SDK client...`);
  const client = await getClient();
  console.log(`${LOG_PREFIX} Copilot SDK client ready`);

  // Initialize orchestrator session
  console.log(`${LOG_PREFIX} Creating orchestrator session...`);
  await initOrchestrator(client);
  console.log(`${LOG_PREFIX} Orchestrator session ready`);

  // Wire up proactive notifications — route to the originating channel
  setProactiveNotify((text, channel) => {
    console.log(`${LOG_PREFIX} bg-notify (${channel ?? "all"}) ⟵  ${truncate(text)}`);
    if (!channel || channel === "telegram") {
      if (config.telegramEnabled) sendProactiveMessage(text);
    }
    if (!channel || channel === "tui") {
      broadcastToSSE(text);
    }
  });

  // Start HTTP API for TUI
  await startApiServer();

  // Start Telegram bot (if configured)
  if (config.telegramEnabled) {
    createBot();
    await startBot();
  } else if (!config.telegramBotToken && config.authorizedUserId === undefined) {
    console.log(`${LOG_PREFIX} Telegram not configured — skipping bot. Configure in the Attache GUI.`);
  } else if (!config.telegramBotToken) {
    console.log(`${LOG_PREFIX} Telegram bot token missing — skipping bot. Add your bot token in the Attache GUI settings.`);
  } else {
    console.log(`${LOG_PREFIX} Telegram user ID missing — skipping bot. Add your Telegram user ID in the Attache GUI settings.`);
  }

  console.log(`${LOG_PREFIX} ${identity.productName} is fully operational.`);

  // Non-blocking update check
  checkForUpdate()
    .then(({ updateAvailable, current, latest }) => {
      if (updateAvailable) {
        console.log(`${LOG_PREFIX} ⬆ Update available: v${current} → v${latest}  —  run 'attache update' to install`);
      }
    })
    .catch(() => {});  // silent — network may be unavailable

  // Notify user if this is a restart (not a fresh start)
  if (config.telegramEnabled && process.env[PRIMARY_RUNTIME_ENV.restarted] === "1") {
    await sendProactiveMessage(`${identity.assistantDisplayName} is back online 🟢`).catch(() => {});
    delete process.env[PRIMARY_RUNTIME_ENV.restarted];
  }
}

// Graceful shutdown
let shutdownState: "idle" | "warned" | "shutting_down" = "idle";
async function shutdown(): Promise<void> {
  if (shutdownState === "shutting_down") {
    console.log(`\n${LOG_PREFIX} Forced exit.`);
    process.exit(1);
  }

  // Check for active workers before shutting down
  const workers = getWorkers();
  const running = Array.from(workers.values()).filter(w => w.status === "running");

  if (running.length > 0 && shutdownState === "idle") {
    const names = running.map(w => w.name).join(", ");
    console.log(`\n${LOG_PREFIX} ⚠ ${running.length} active worker(s) will be destroyed: ${names}`);
    console.log(`${LOG_PREFIX} Press Ctrl+C again to shut down, or wait for workers to finish.`);
    shutdownState = "warned";
    return;
  }

  shutdownState = "shutting_down";
  console.log(`\n${LOG_PREFIX} Shutting down... (Ctrl+C again to force)`);

  // Force exit after 3 seconds no matter what
  const forceTimer = setTimeout(() => {
    console.log(`${LOG_PREFIX} Shutdown timed out — forcing exit.`);
    process.exit(1);
  }, 3000);
  forceTimer.unref();

  if (config.telegramEnabled) {
    try { await stopBot(); } catch { /* best effort */ }
  }

  // Destroy all active worker sessions to free memory
  await Promise.allSettled(
    Array.from(workers.values()).map((w) => w.session.destroy())
  );
  workers.clear();

  try { await stopClient(); } catch { /* best effort */ }
  closeDb();
  console.log(`${LOG_PREFIX} Goodbye.`);
  process.exit(0);
}

/** Restart the daemon by spawning a new process and exiting. */
export async function restartDaemon(): Promise<void> {
  const identity = getEffectiveIdentity();
  console.log(`${LOG_PREFIX} Restarting...`);

  const activeWorkers = getWorkers();
  const runningCount = Array.from(activeWorkers.values()).filter(w => w.status === "running").length;
  if (runningCount > 0) {
    console.log(`${LOG_PREFIX} ⚠ Destroying ${runningCount} active worker(s) for restart`);
  }

  if (config.telegramEnabled) {
    await sendProactiveMessage(`${identity.assistantDisplayName} is restarting — back in a sec ⏳`).catch(() => {});
    try { await stopBot(); } catch { /* best effort */ }
  }

  // Destroy all active worker sessions to free memory
  await Promise.allSettled(
    Array.from(activeWorkers.values()).map((w) => w.session.destroy())
  );
  activeWorkers.clear();

  try { await stopClient(); } catch { /* best effort */ }
  closeDb();

  // Spawn a detached replacement process with the same args (include execArgv for tsx/loaders)
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      [PRIMARY_RUNTIME_ENV.restarted]: "1",
    },
  });
  child.unref();

  console.log(`${LOG_PREFIX} New process spawned. Exiting old process.`);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Prevent unhandled errors from crashing the daemon
process.on("unhandledRejection", (reason) => {
  console.error(`${LOG_PREFIX} Unhandled rejection (kept alive):`, reason);
});
process.on("uncaughtException", (err) => {
  console.error(`${LOG_PREFIX} Uncaught exception — shutting down:`, err);
  process.exit(1);
});

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal error:`, err);
  process.exit(1);
});
