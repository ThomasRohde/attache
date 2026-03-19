import { Bot, type Context } from "grammy";
import { config, validateAndSwitchModel } from "../config.js";
import { sendToOrchestrator, cancelCurrentMessage, getWorkers, resetSession } from "../copilot/orchestrator.js";
import { ATTACHE_UPLOADS_DIR } from "../paths.js";
import { chunkMessage, toTelegramMarkdown } from "./formatter.js";
import { writeFileSync } from "fs";
import { join } from "path";
import { searchMemories, clearConversationLog } from "../store/db.js";
import { listSkills } from "../copilot/skills.js";
import { restartDaemon } from "../daemon.js";
import { getEffectiveIdentity, LOG_PREFIX } from "../identity.js";
import { broadcastTranscriptEntry } from "../api/server.js";
import { getBackendClient } from "../backend/registry.js";

let bot: Bot | undefined;

export function createBot(): Bot {
  const identity = getEffectiveIdentity();
  if (!config.telegramBotToken) {
    throw new Error("Telegram bot token is missing. Run 'attache setup' and enter the bot token from @BotFather.");
  }
  if (config.authorizedUserId === undefined) {
    throw new Error("Telegram user ID is missing. Run 'attache setup' and enter your Telegram user ID (get it from @userinfobot).");
  }
  bot = new Bot(config.telegramBotToken);

  // Auth middleware — only allow the authorized user
  bot.use(async (ctx, next) => {
    if (config.authorizedUserId === undefined || ctx.from?.id !== config.authorizedUserId) {
      return; // Silently ignore unauthorized users
    }
    await next();
  });

  // /start and /help
  bot.command("start", (ctx) => ctx.reply(`${identity.assistantDisplayName} is online via ${identity.productName}. Send me anything.`));
  bot.command("help", (ctx) =>
    ctx.reply(
      `I'm ${identity.assistantDisplayName}, your assistant on ${identity.productName}.\n\n` +
        "Just send me a message and I'll handle it.\n\n" +
        "Commands:\n" +
        "/cancel — Cancel the current message\n" +
        "/clear — Clear conversation and start fresh\n" +
        "/new — Same as /clear\n" +
        "/model — Show current model\n" +
        "/model <name> — Switch model\n" +
        "/provider — Show or switch backend provider\n" +
        "/memory — Show stored memories\n" +
        "/skills — List installed skills\n" +
        "/workers — List active worker sessions\n" +
        `/restart — Restart ${identity.assistantDisplayName}\n` +
        "/help — Show this help"
    )
  );
  bot.command("cancel", async (ctx) => {
    const cancelled = await cancelCurrentMessage();
    await ctx.reply(cancelled ? "⛔ Cancelled." : "Nothing to cancel.");
  });
  bot.command("model", async (ctx) => {
    const arg = ctx.match?.trim();
    if (arg) {
      const result = await validateAndSwitchModel(arg, getBackendClient());
      if (!result.ok) {
        await ctx.reply(result.error);
        return;
      }
      const { resetForModelSwitch } = await import("../copilot/orchestrator.js");
      resetForModelSwitch();
      await ctx.reply(`Model: ${result.previous} → ${arg}`);
    } else {
      await ctx.reply(`Current model: ${config.copilotModel}`);
    }
  });
  bot.command("memory", async (ctx) => {
    const memories = searchMemories(undefined, undefined, 50);
    if (memories.length === 0) {
      await ctx.reply("No memories stored.");
    } else {
      const lines = memories.map((m) => `#${m.id} [${m.category}] ${m.content}`);
      await ctx.reply(lines.join("\n") + `\n\n${memories.length} total`);
    }
  });
  bot.command("skills", async (ctx) => {
    const skills = listSkills();
    if (skills.length === 0) {
      await ctx.reply("No skills installed.");
    } else {
      const lines = skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`);
      await ctx.reply(lines.join("\n"));
    }
  });
  bot.command("provider", async (ctx) => {
    const arg = ctx.match?.trim();
    if (arg) {
      const supported = ["copilot", "claude", "codex"];
      if (!supported.includes(arg)) {
        await ctx.reply(`Unknown provider '${arg}'. Supported: ${supported.join(", ")}`);
        return;
      }
      const { getBackendName } = await import("../backend/registry.js");
      const previous = getBackendName();
      if (arg === previous) {
        await ctx.reply(`Already using provider: ${arg}`);
        return;
      }
      const { persistEnvVar } = await import("../config.js");
      persistEnvVar("ATTACHE_BACKEND", arg);
      await ctx.reply(`Switching provider: ${previous} → ${arg}. Restarting...`);
      setTimeout(() => {
        restartDaemon().catch((err) => {
          console.error(`${LOG_PREFIX} Restart failed:`, err);
        });
      }, 500);
    } else {
      const { getBackendName } = await import("../backend/registry.js");
      await ctx.reply(`Current provider: ${getBackendName()}`);
    }
  });
  bot.command("workers", async (ctx) => {
    const workers = Array.from(getWorkers().values());
    if (workers.length === 0) {
      await ctx.reply("No active worker sessions.");
    } else {
      const lines = workers.map((w) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
      await ctx.reply(lines.join("\n"));
    }
  });
  const handleClearCommand = async (ctx: Context) => {
    await resetSession();
    clearConversationLog();
    const { broadcastClearedEvent } = await import("../api/server.js");
    broadcastClearedEvent();
    await ctx.reply("Session cleared. Starting fresh.");
  };
  bot.command("clear", handleClearCommand);
  bot.command("new", handleClearCommand);

  bot.command("restart", async (ctx) => {
    await ctx.reply(`⏳ Restarting ${identity.assistantDisplayName}...`);
    setTimeout(() => {
      restartDaemon().catch((err) => {
        console.error(`${LOG_PREFIX} Restart failed:`, err);
      });
    }, 500);
  });

  /** Send a prompt (with optional attachments) to the orchestrator and handle typing/timeout/response. */
  function handleIncomingMessage(
    ctx: Context,
    chatId: number,
    userMessageId: number,
    prompt: string,
    attachments?: import("../backend/types.js").Attachment[],
  ): void {
    const replyParams = { message_id: userMessageId };

    // Show "typing..." indicator, repeat every 4s while processing
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    const startTyping = () => {
      void ctx.replyWithChatAction("typing").catch(() => {});
      typingInterval = setInterval(() => {
        void ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
    };
    const stopTyping = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = undefined;
      }
    };

    startTyping();

    // Broadcast the user's message to SSE clients
    broadcastTranscriptEntry("user", prompt, "telegram");

    // Safety timeout
    let responded = false;
    const safetyTimeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        stopTyping();
        void ctx.reply("⏳ Response timed out. The orchestrator may be overloaded — try again or use /cancel.", {
          reply_parameters: replyParams,
        }).catch(() => {});
      }
    }, config.workerTimeoutMs);

    sendToOrchestrator(
      prompt,
      { type: "telegram", chatId, messageId: userMessageId },
      (text: string, done: boolean) => {
        if (done) {
          if (responded) return;
          responded = true;
          clearTimeout(safetyTimeout);
          stopTyping();
          broadcastTranscriptEntry("assistant", text, "telegram");
          void (async () => {
            const formatted = toTelegramMarkdown(text);
            const chunks = chunkMessage(formatted);
            const fallbackChunks = chunkMessage(text);
            const sendChunk = async (chunk: string, fallback: string, isFirst: boolean) => {
              const opts = isFirst
                ? { parse_mode: "MarkdownV2" as const, reply_parameters: replyParams }
                : { parse_mode: "MarkdownV2" as const };
              await ctx.reply(chunk, opts).catch(
                () => ctx.reply(fallback, isFirst ? { reply_parameters: replyParams } : {})
              );
            };
            try {
              for (let i = 0; i < chunks.length; i++) {
                await sendChunk(chunks[i], fallbackChunks[i] ?? chunks[i], i === 0);
              }
            } catch {
              try {
                for (let i = 0; i < fallbackChunks.length; i++) {
                  await ctx.reply(fallbackChunks[i], i === 0 ? { reply_parameters: replyParams } : {});
                }
              } catch {
                // Nothing more we can do
              }
            }
          })();
        }
      },
      attachments
    );
  }

  // Handle all text messages
  bot.on("message:text", async (ctx) => {
    handleIncomingMessage(ctx, ctx.chat.id, ctx.message.message_id, ctx.message.text);
  });

  // Handle photo messages
  bot.on("message:photo", async (ctx) => {
    try {
      // Get highest-resolution photo (last in array)
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      const file = await ctx.api.getFile(photo.file_id);

      if (!file.file_path) {
        await ctx.reply("Could not download the photo.");
        return;
      }

      // Download to uploads dir
      const ext = file.file_path.includes(".") ? file.file_path.slice(file.file_path.lastIndexOf(".")) : ".jpg";
      const fileName = `tg-${Date.now()}${ext}`;
      const localPath = join(ATTACHE_UPLOADS_DIR, fileName);

      const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        await ctx.reply("Failed to download the photo from Telegram.");
        return;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      writeFileSync(localPath, buffer);

      const caption = ctx.message.caption || "Attached photo";
      handleIncomingMessage(
        ctx,
        ctx.chat.id,
        ctx.message.message_id,
        caption,
        [{ type: "file", path: localPath, displayName: fileName }],
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to process Telegram photo:`, err instanceof Error ? err.message : err);
      await ctx.reply("Failed to process the photo.").catch(() => {});
    }
  });

  return bot;
}

export async function startBot(): Promise<void> {
  if (!bot) throw new Error("Bot not created");
  console.log(`${LOG_PREFIX} Telegram bot starting...`);
  bot.start({
    onStart: () => console.log(`${LOG_PREFIX} Telegram bot connected`),
  }).catch((err: any) => {
    if (err?.error_code === 401) {
      console.error(`${LOG_PREFIX} ⚠️ Telegram bot token is invalid or expired. Run 'attache setup' and re-enter your bot token from @BotFather.`);
    } else if (err?.error_code === 409) {
      console.error(`${LOG_PREFIX} ⚠️ Another bot instance is already running with this token. Stop the other instance first.`);
    } else {
      console.error(`${LOG_PREFIX} ❌ Telegram bot failed to start:`, err?.message || err);
    }
  });
}

export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stop();
  }
}

/** Send an unsolicited message to the authorized user (for background task completions). */
export async function sendProactiveMessage(text: string): Promise<void> {
  if (!bot || config.authorizedUserId === undefined) return;
  const formatted = toTelegramMarkdown(text);
  const chunks = chunkMessage(formatted);
  const fallbackChunks = chunkMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    try {
      await bot.api.sendMessage(config.authorizedUserId, chunks[i], { parse_mode: "MarkdownV2" });
    } catch {
      try {
        await bot.api.sendMessage(config.authorizedUserId, fallbackChunks[i] ?? chunks[i]);
      } catch {
        // Bot may not be connected yet
      }
    }
  }
}

/** Send a photo to the authorized user. Accepts a file path or URL. */
export async function sendPhoto(photo: string, caption?: string): Promise<void> {
  if (!bot || config.authorizedUserId === undefined) return;
  try {
    const { InputFile } = await import("grammy");
    const input = photo.startsWith("http") ? photo : new InputFile(photo);
    await bot.api.sendPhoto(config.authorizedUserId, input, {
      caption,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to send photo:`, err instanceof Error ? err.message : err);
    throw err;
  }
}
