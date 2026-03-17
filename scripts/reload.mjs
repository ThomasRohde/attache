#!/usr/bin/env node
// Rebuild and restart Attache (daemon + optionally GUI).
// Usage:
//   npm run reload        — build TS, restart daemon
//   npm run reload:all    — build TS + GUI, restart daemon + GUI

import { execSync, spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const all = process.argv.includes("--all");

function run(label, cmd) {
  console.log(`[reload] ${label}...`);
  try {
    execSync(cmd, { stdio: "inherit", windowsHide: true });
  } catch {
    console.error(`[reload] FAILED: ${label}`);
    process.exit(1);
  }
}

async function restartDaemon() {
  let token;
  try {
    token = readFileSync(join(homedir(), ".attache", "api-token"), "utf-8").trim();
  } catch {
    console.log("[reload] No API token — start daemon manually with: npm run daemon");
    return;
  }

  console.log("[reload] Restarting daemon...");
  try {
    const resp = await fetch("http://127.0.0.1:7777/restart", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch {
    console.log("[reload] Daemon not running — start manually with: npm run daemon");
    return;
  }

  // Wait for it to come back
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const resp = await fetch("http://127.0.0.1:7777/status");
      if (resp.ok) {
        console.log("[reload] Daemon restarted OK");
        return;
      }
    } catch {}
  }
  console.log("[reload] Daemon did not respond after restart");
}

function restartGui() {
  console.log("[reload] Restarting GUI...");
  try {
    execSync("taskkill /IM AttacheGui.exe /F", { stdio: "ignore", windowsHide: true });
  } catch {}

  setTimeout(() => {
    const child = spawn("cmd", ["/c", "start", "", "gui\\dist-win\\AttacheGui.exe"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    console.log("[reload] GUI launched");
  }, 1500);
}

function killGui() {
  console.log("[reload] Stopping GUI...");
  try {
    execSync("taskkill /IM AttacheGui.exe /F", { stdio: "ignore", windowsHide: true });
    // Wait for the process and file lock to release
    execSync("timeout /t 2 /nobreak >nul", { stdio: "ignore", windowsHide: true });
  } catch {}
}

function launchGui() {
  console.log("[reload] Launching GUI...");
  const child = spawn("cmd", ["/c", "start", "", "gui\\dist-win\\AttacheGui.exe"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.log("[reload] GUI launched");
}

// ── Main ──────────────────────────────────────────────────

// Kill GUI first so the exe is unlocked for the build
if (all) {
  killGui();
}

run("Building TypeScript", "npx tsc");

if (all) {
  run("Building GUI", "dotnet publish gui/AttacheGui.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -o gui/dist-win");
}

await restartDaemon();

if (all) {
  launchGui();
}

console.log("[reload] Done.");
