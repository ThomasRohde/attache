/**
 * Prevent Windows from sleeping while the daemon is running.
 *
 * Spawns a PowerShell child that calls SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED).
 * The wake lock is held as long as the child is alive. Killing the child (or letting it exit
 * when the daemon shuts down) automatically clears the state.
 */

import { spawn, type ChildProcess } from "child_process";
import { LOG_PREFIX } from "./identity.js";

let wakeLockProcess: ChildProcess | null = null;

const PS_SCRIPT = [
  "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);' -Name WL -Namespace K;",
  "[K.WL]::SetThreadExecutionState(0x80000001) | Out-Null;",  // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
  "[Console]::In.ReadLine()",                                   // block until stdin closes
].join(" ");

export function acquireWakeLock(): boolean {
  if (process.platform !== "win32") return false;
  if (wakeLockProcess) return true; // already held

  try {
    wakeLockProcess = spawn("powershell.exe", ["-NoProfile", "-Command", PS_SCRIPT], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });

    wakeLockProcess.on("exit", () => {
      wakeLockProcess = null;
    });

    console.log(`${LOG_PREFIX} Wake lock acquired — system sleep prevented`);
    return true;
  } catch (err) {
    console.log(`${LOG_PREFIX} ⚠ Failed to acquire wake lock: ${err}`);
    return false;
  }
}

export function releaseWakeLock(): void {
  if (!wakeLockProcess) return;

  try {
    wakeLockProcess.stdin?.end();
    wakeLockProcess.kill();
  } catch {
    // best effort
  }
  wakeLockProcess = null;
}
