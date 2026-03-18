#!/usr/bin/env node

import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const dotnetCmd = isWin ? "dotnet.exe" : "dotnet";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });

    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}`));
    });
  });
}

async function main() {
  const guiProject = resolve(rootDir, "gui", "AttacheGui.csproj");
  if (!existsSync(guiProject)) {
    throw new Error(`Could not find the GUI project at ${guiProject}`);
  }

  console.log("[start] Building TypeScript daemon...");
  await run(npmCmd, ["run", "build:ts"]);

  console.log("[start] Launching GUI from source...");
  await run(dotnetCmd, ["run", "--project", "gui/AttacheGui.csproj"]);
}

main().catch((err) => {
  console.error("[start] Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
