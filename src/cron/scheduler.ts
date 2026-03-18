import cron from "node-cron";
import {
  getCronJobs,
  getCronJob,
  logCronExecution,
  completeCronExecution,
  updateCronJobRunState,
  logConversation,
  type CronJob,
} from "../store/db.js";
import { sendToOrchestrator } from "../copilot/orchestrator.js";
import { broadcastToSSE, broadcastTranscriptEntry, broadcastCronEvent } from "../api/server.js";
import { getBackendName } from "../backend/registry.js";
import { config } from "../config.js";
import { LOG_PREFIX } from "../identity.js";

const activeTasks = new Map<number, cron.ScheduledTask>();
const runningJobs = new Set<number>();

function scheduleJob(job: CronJob): void {
  unscheduleJob(job.id);

  if (!job.enabled) return;

  if (!cron.validate(job.cron_expression)) {
    console.error(`${LOG_PREFIX} [cron] Invalid expression for job #${job.id} "${job.name}": ${job.cron_expression}`);
    return;
  }

  const task = cron.schedule(job.cron_expression, () => {
    executeJob(job.id);
  });

  activeTasks.set(job.id, task);
  console.log(`${LOG_PREFIX} [cron] Scheduled job #${job.id} "${job.name}" (${job.cron_expression})`);
}

function unscheduleJob(id: number): void {
  const existing = activeTasks.get(id);
  if (existing) {
    existing.stop();
    activeTasks.delete(id);
  }
}

async function executeJob(jobId: number): Promise<void> {
  // Guard: skip if already running or still queued for completion.
  if (runningJobs.has(jobId)) {
    console.log(`${LOG_PREFIX} [cron] Skipping job #${jobId} — previous execution still running`);
    return;
  }

  const job = getCronJob(jobId);
  if (!job || !job.enabled) return;

  // Guard against duplicate execution within the same calendar minute
  // (can happen if the daemon restarts mid-minute and re-fires the job).
  if (job.last_run_at) {
    const lastRun = new Date(job.last_run_at);
    const now = new Date();
    if (
      lastRun.getFullYear() === now.getFullYear() &&
      lastRun.getMonth() === now.getMonth() &&
      lastRun.getDate() === now.getDate() &&
      lastRun.getHours() === now.getHours() &&
      lastRun.getMinutes() === now.getMinutes()
    ) {
      console.log(`${LOG_PREFIX} [cron] Skipping job #${jobId} "${job.name}" — already ran this minute`);
      return;
    }
  }

  // Guard: skip if the job requires a specific backend that isn't active.
  if (job.backend) {
    const activeBackend = getBackendName();
    if (job.backend !== activeBackend) {
      console.log(`${LOG_PREFIX} [cron] Skipping job #${jobId} "${job.name}" — requires ${job.backend} backend, active is ${activeBackend}`);
      return;
    }
  }

  runningJobs.add(jobId);
  const startedAt = Date.now();

  // Insert execution row
  const executionId = logCronExecution(jobId, "running");

  // Update job state
  updateCronJobRunState(jobId, {
    lastRunAt: new Date().toISOString(),
    lastStatus: "running",
  });

  // Broadcast execution started
  broadcastCronEvent("cron.execution.started", { id: executionId, jobId, jobName: job.name });

  console.log(`${LOG_PREFIX} [cron] Executing job #${jobId} "${job.name}"`);

  // Send to orchestrator as background message
  const prompt = `[Scheduled task "${job.name}"] ${job.prompt}`;
  logConversation("system", `Cron job "${job.name}" triggered`, "cron");

  sendToOrchestrator(
    prompt,
    { type: "background" },
    (text, done) => {
      if (!done) return;

      const durationMs = Date.now() - startedAt;
      // Heuristic: if the orchestrator response looks like an error, mark as failure
      const isError = /^(error|failed|exception|refused|timeout)/i.test(text.trim());
      const status: "success" | "failure" = isError ? "failure" : "success";

      // Complete the execution record
      completeCronExecution(executionId, status, text, durationMs);

      // Update job run state
      const currentJob = getCronJob(jobId);
      updateCronJobRunState(jobId, {
        lastStatus: status,
        runCount: (currentJob?.run_count ?? 0) + 1,
      });

      // Log to conversation
      logConversation("assistant", text, "cron");

      // Broadcast completion via transcript (cron channel) and cron event
      broadcastTranscriptEntry("assistant", text, "cron");
      broadcastCronEvent("cron.execution.complete", { id: executionId, jobId, jobName: job.name, status, durationMs });

      // Notify the user in the GUI — proactive message visible on the tui channel
      const summary = `**[${job.name}]** ${text}`;
      broadcastToSSE(summary);

      // Telegram notification — only send if telegram is enabled AND job requests it
      const jobForNotify = getCronJob(jobId);
      if (config.telegramEnabled && jobForNotify?.notify_telegram) {
        import("../telegram/bot.js").then(({ sendProactiveMessage }) => {
          sendProactiveMessage(`[${job.name}] ${text}`).catch((err) => {
            console.error(`${LOG_PREFIX} [cron] Telegram send failed for job #${jobId}:`, err);
          });
        }).catch((err) => {
          console.error(`${LOG_PREFIX} [cron] Failed to import telegram bot:`, err);
        });
      }

      console.log(`${LOG_PREFIX} [cron] Job #${jobId} "${job.name}" ${status} in ${durationMs}ms`);
      runningJobs.delete(jobId);
    },
  );
}

export function startCronScheduler(): void {
  const jobs = getCronJobs();
  const enabled = jobs.filter((j) => j.enabled);
  console.log(`${LOG_PREFIX} [cron] Starting scheduler — ${enabled.length} enabled job(s) of ${jobs.length} total`);

  for (const job of enabled) {
    scheduleJob(job);
  }
}

export function stopCronScheduler(): void {
  for (const [, task] of activeTasks) {
    task.stop();
  }
  activeTasks.clear();
  runningJobs.clear();
  console.log(`${LOG_PREFIX} [cron] Scheduler stopped`);
}

/** Schedule or reschedule a single job (call after create/update). */
export function rescheduleJob(jobId: number): void {
  const job = getCronJob(jobId);
  if (!job) {
    unscheduleJob(jobId);
    return;
  }
  if (job.enabled) {
    scheduleJob(job);
  } else {
    unscheduleJob(jobId);
  }
}

/** Remove a job's timer (call after delete). */
export { unscheduleJob };

/** Validate a cron expression. */
export function validateCronExpression(expr: string): boolean {
  return cron.validate(expr);
}
