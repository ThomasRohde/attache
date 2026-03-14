#!/usr/bin/env node

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { PRIMARY_COMMAND, PRODUCT_NAME, PUBLISHED_PACKAGE_NAME } from "./update.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp(): void {
  const version = getVersion();
  console.log(`
${PRODUCT_NAME} v${version} — AI orchestrator powered by Copilot SDK

Usage:
  ${PRIMARY_COMMAND} <command>

Commands:
  start       Start the ${PRODUCT_NAME} daemon (Telegram bot + HTTP API)
  tui         Connect to the daemon via the Ink terminal UI
  tui:legacy  Connect via the legacy readline terminal UI
  setup       Interactive first-run configuration
  update      Check for updates and install the latest version
  help        Show this help message

Flags (start):
  --self-edit Allow ${PRODUCT_NAME} to modify its own source code (off by default)

Examples:
  ${PRIMARY_COMMAND} start             Start the daemon
  ${PRIMARY_COMMAND} start --self-edit Start with self-edit enabled
  ${PRIMARY_COMMAND} tui               Open the Ink terminal client
  ${PRIMARY_COMMAND} tui:legacy        Open the legacy readline client
  ${PRIMARY_COMMAND} setup             Configure Telegram token and settings

Package:
  - Updates install the npm package \`${PUBLISHED_PACKAGE_NAME}\`.
`.trim());
}

const args = process.argv.slice(2);
const command = args[0] || "help";

switch (command) {
  case "start": {
    const startFlags = args.slice(1);
    if (startFlags.includes("--self-edit")) {
      process.env.ATTACHE_SELF_EDIT = "1";
    }
    await import("./daemon.js");
    break;
  }
  case "tui":
  {
    const { runInkTui } = await import("./ui/ink/index.js");
    runInkTui();
    break;
  }
  case "tui:legacy":
    await import("./tui/index.js");
    break;
  case "setup":
    await import("./setup.js");
    break;
  case "update": {
    const { checkForUpdate, performUpdate } = await import("./update.js");
    const check = await checkForUpdate();
    if (!check.checkSucceeded) {
      console.error(`⚠ Could not reach the npm registry for ${PRODUCT_NAME} updates. Check your network and try again.`);
      process.exit(1);
    }
    if (!check.updateAvailable) {
      console.log(`${PRODUCT_NAME} v${check.current} is already the latest version.`);
      break;
    }
    console.log(`${PRODUCT_NAME} update available: v${check.current} → v${check.latest}`);
    console.log(`Installing via npm package \`${PUBLISHED_PACKAGE_NAME}\`...`);
    const result = await performUpdate();
    if (result.ok) {
      console.log(`✅ ${PRODUCT_NAME} updated to v${check.latest}`);
    } else {
      console.error(`❌ ${PRODUCT_NAME} update failed: ${result.output}`);
      process.exit(1);
    }
    break;
  }
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  case "--version":
  case "-v":
    console.log(getVersion());
    break;
  default:
    console.error(`Unknown command: ${command}
`);
    printHelp();
    process.exit(1);
}
