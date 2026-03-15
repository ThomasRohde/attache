import { Box, Text, useApp, useInput } from "ink";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createDaemonClient,
  type DiagnosticsResponse,
  type EffectiveConfigResponse,
  type WorkerSummary,
} from "../shared/daemon-client.js";
import { MarkdownText } from "./markdown.js";
import { InlineTextInput } from "./text-input.js";

type FocusPane = "workers" | "transcript" | "inspector" | "composer";
type ConnectionState = "connecting" | "connected" | "disconnected";
type TranscriptRole = "user" | "assistant" | "system";

interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  content: string;
}

interface TranscriptLine {
  key: string;
  role: TranscriptRole;
  prefix: string;
  text: string;
  codeBlock?: boolean;
}

const FOCUS_ORDER: FocusPane[] = ["workers", "transcript", "inspector", "composer"];
const MAX_TRANSCRIPT_ENTRIES = 120;

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function readTerminalSize(): { columns: number; rows: number } {
  return {
    columns: process.stdout.columns || 120,
    rows: process.stdout.rows || 32,
  };
}

function trimToSingleLine(value: string, width: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= width) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, width - 1))}…`;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 1) {
    return [text];
  }

  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.length > 0 ? rawLine : " ";
    const words = line.split(/(\s+)/).filter((part) => part.length > 0);
    let current = "";

    for (const word of words) {
      if (word.trim().length === 0) {
        if (current.length > 0 && current.length < width) {
          current += word;
        }
        continue;
      }

      if ((current + word).length <= width) {
        current += word;
        continue;
      }

      if (current.trim().length > 0) {
        lines.push(current.trimEnd());
        current = "";
      }

      if (word.length <= width) {
        current = word;
        continue;
      }

      let remaining = word;
      while (remaining.length > width) {
        lines.push(remaining.slice(0, width - 1) + "…");
        remaining = remaining.slice(width - 1);
      }
      current = remaining;
    }

    lines.push(current.trimEnd() || " ");
  }

  return lines;
}

function formatElapsed(ms: number | null | undefined): string {
  if (!ms || ms < 0) {
    return "—";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) {
    return "0 MB";
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function transcriptColor(role: TranscriptRole): "cyan" | "green" | "yellow" {
  switch (role) {
    case "user":
      return "cyan";
    case "assistant":
      return "green";
    case "system":
    default:
      return "yellow";
  }
}

function workerStatusColor(status: string): "green" | "yellow" | "red" | "white" {
  switch (status) {
    case "idle":
      return "green";
    case "running":
      return "yellow";
    case "error":
      return "red";
    default:
      return "white";
  }
}

function nextFocus(current: FocusPane): FocusPane {
  const index = FOCUS_ORDER.indexOf(current);
  return FOCUS_ORDER[(index + 1) % FOCUS_ORDER.length] ?? "composer";
}

function shouldDeferPolling(state: {
  focus: FocusPane;
  composer: string;
  sending: boolean;
}): boolean {
  return !state.sending && state.focus === "composer" && state.composer.length > 0;
}

function appendTranscriptEntry(
  setEntries: React.Dispatch<React.SetStateAction<TranscriptEntry[]>>,
  entry: TranscriptEntry,
): void {
  setEntries((current) => [...current, entry].slice(-MAX_TRANSCRIPT_ENTRIES));
}

function Pane({
  title,
  focused,
  width,
  children,
}: {
  title: string;
  focused: boolean;
  width?: number;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Box
      width={width}
      flexGrow={width ? 0 : 1}
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? "cyan" : "white"}
      paddingX={1}
    >
      <Text color={focused ? "cyan" : "white"}>{title}</Text>
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}

const DashboardPanels = memo(function DashboardPanels({
  focus,
  workers,
  selectedWorkerId,
  leftWidth,
  rightWidth,
  transcriptTitle,
  transcriptLines,
  diagnosticsLines,
}: {
  focus: FocusPane;
  workers: WorkerSummary[];
  selectedWorkerId: string | null;
  leftWidth: number;
  rightWidth: number;
  transcriptTitle: string;
  transcriptLines: TranscriptLine[];
  diagnosticsLines: string[];
}): JSX.Element {
  return (
    <Box flexGrow={1}>
      <Pane title={`Workers (${workers.length})`} focused={focus === "workers"} width={leftWidth}>
        {workers.length === 0 ? (
          <Text dimColor>No active workers.</Text>
        ) : (
          workers.map((worker, index) => {
            const selected = worker.id === selectedWorkerId;
            const marker = selected ? ">" : " ";
            const detail = trimToSingleLine(worker.workingDir, Math.max(10, leftWidth - 6));
            return (
              <Box key={worker.id} flexDirection="column" marginBottom={index === workers.length - 1 ? 0 : 1}>
                <Text color={selected ? "cyan" : workerStatusColor(worker.status)}>
                  {marker} {worker.name} [{worker.status}]
                </Text>
                <Text dimColor>{detail}</Text>
              </Box>
            );
          })
        )}
      </Pane>

      <Box width={1} />

      <Pane title={transcriptTitle} focused={focus === "transcript"}>
        {transcriptLines.map((line) => (
          <Text key={line.key} color={transcriptColor(line.role)}>
            {line.prefix}
            <MarkdownText
              text={line.text}
              baseColor={transcriptColor(line.role)}
              codeBlock={line.codeBlock}
            />
          </Text>
        ))}
      </Pane>

      <Box width={1} />

      <Pane title="Inspector" focused={focus === "inspector"} width={rightWidth}>
        {diagnosticsLines.map((line, index) => (
          <Text key={`${index}-${line}`} dimColor={line.trim() === ""}>
            {line}
          </Text>
        ))}
      </Pane>
    </Box>
  );
});

const ComposerPane = memo(function ComposerPane({
  focus,
  connectionState,
  statusMessage,
  inputWidth,
  onSubmit,
  onDraftChange,
}: {
  focus: FocusPane;
  connectionState: ConnectionState;
  statusMessage: string;
  inputWidth: number;
  onSubmit: (prompt: string) => Promise<boolean>;
  onDraftChange: (draft: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");

  const handleChange = useCallback((nextDraft: string) => {
    setDraft(nextDraft);
    onDraftChange(nextDraft);
  }, [onDraftChange]);

  const handleSubmit = useCallback(async (value: string) => {
    const shouldClear = await onSubmit(value);
    if (shouldClear) {
      setDraft("");
      onDraftChange("");
    }
  }, [onDraftChange, onSubmit]);

  return (
    <Box flexShrink={0} height={8}>
      <Pane title={`Composer${focus === "composer" ? " [focused]" : ""}`} focused={focus === "composer"}>
        <Text color={connectionState === "connected" ? "green" : connectionState === "connecting" ? "yellow" : "red"}>
          {connectionState === "connected" ? "● connected" : connectionState === "connecting" ? "● connecting" : "● disconnected"}
        </Text>
        <Box>
          <Text color="cyan">{"> "}</Text>
          <Box flexGrow={1}>
            <InlineTextInput
              value={draft}
              placeholder="Type a prompt..."
              focus={focus === "composer"}
              width={inputWidth}
              onChange={handleChange}
              onSubmit={handleSubmit}
            />
          </Box>
        </Box>
        <Text dimColor>{statusMessage}</Text>
        <Text dimColor>Tab focus • ↑/↓ select worker • Esc cancel • Enter send • q/Ctrl+C quit</Text>
      </Pane>
    </Box>
  );
});

export function InkShellApp(): JSX.Element {
  const { exit } = useApp();
  const client = useMemo(() => createDaemonClient(), []);

  const [size, setSize] = useState(readTerminalSize);
  const [focus, setFocus] = useState<FocusPane>("composer");
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveConfigResponse | null>(null);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [statusMessage, setStatusMessage] = useState("Connecting to daemon…");
  const [sending, setSending] = useState(false);
  const [lastRouteSummary, setLastRouteSummary] = useState<string>("No route yet");
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);

  const activeMessageRef = useRef(false);
  const visibleActivityRef = useRef(false);
  const pollingStateRef = useRef({
    focus: "composer" as FocusPane,
    composer: "",
    sending: false,
  });

  useEffect(() => {
    pollingStateRef.current = {
      focus,
      composer: pollingStateRef.current.composer,
      sending,
    };
  }, [focus, sending]);

  useEffect(() => {
    const handleResize = () => {
      setSize(readTerminalSize());
    };

    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      try {
        const data = await client.getJson<EffectiveConfigResponse>("/config/effective");
        if (!cancelled) {
          setEffectiveConfig(data);
        }
      } catch (error) {
        if (!cancelled) {
          setStatusMessage(`Config fetch failed: ${describeError(error)}`);
        }
      }
    };

    void loadConfig();

    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      // Ink redraws the full layout on each render. While the user is editing
      // a draft, defer background polling so the composer stays visually stable.
      if (shouldDeferPolling(pollingStateRef.current)) {
        return;
      }

      try {
        const [sessionData, diagnosticsData] = await Promise.all([
          client.getJson<WorkerSummary[]>("/sessions"),
          client.getJson<DiagnosticsResponse>("/diagnostics"),
        ]);

        if (cancelled || shouldDeferPolling(pollingStateRef.current)) {
          return;
        }

        setWorkers(sessionData);
        setDiagnostics(diagnosticsData);
      } catch (error) {
        if (!cancelled) {
          setStatusMessage(`Polling failed: ${describeError(error)}`);
        }
      }
    };

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client]);

  useEffect(() => {
    if (workers.length === 0) {
      setSelectedWorkerId(null);
      return;
    }

    if (!selectedWorkerId || !workers.some((worker) => worker.id === selectedWorkerId)) {
      setSelectedWorkerId(workers[0]?.id ?? null);
    }
  }, [workers, selectedWorkerId]);

  useEffect(() => {
    let streamHandle: { close: () => void } | undefined;
    let retryTimer: NodeJS.Timeout | undefined;
    let cancelled = false;
    const scheduleReconnect = (delayMs: number, message: string) => {
      if (cancelled) {
        return;
      }

      if (retryTimer) {
        clearTimeout(retryTimer);
      }

      setConnectionState("disconnected");
      setConnectionId(null);
      setStatusMessage(message);
      retryTimer = setTimeout(connect, delayMs);
    };

    const connect = () => {
      setConnectionState("connecting");
      setStatusMessage("Connecting to stream…");

      streamHandle = client.openEventStream({
        onConnected(id) {
          if (cancelled) {
            return;
          }

          setConnectionId(id);
          setConnectionState("connected");
          setStatusMessage(`Connected to ${client.config.apiBase}`);
        },
        onEvent(type, event) {
          if (cancelled) {
            return;
          }

          if (type === "delta") {
            activeMessageRef.current = true;
            visibleActivityRef.current = true;
            setSending(true);
            setStreamingContent(event.content ?? "");
            setStatusMessage("Streaming response…");
            return;
          }

          if (type === "message") {
            activeMessageRef.current = false;
            visibleActivityRef.current = false;
            setSending(false);
            setStreamingContent("");
            const content = event.content?.trim() ? event.content : "(empty response)";
            appendTranscriptEntry(setEntries, {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content,
            });

            const route = event.route;
            if (route) {
              const summary = route.overrideName
                ? `${route.routerMode} · ${route.model} (${route.overrideName})`
                : `${route.routerMode} · ${route.model}`;
              setLastRouteSummary(summary);
              setStatusMessage(`Completed via ${summary}`);
            } else {
              setStatusMessage("Response complete");
            }

            return;
          }

          if (type === "cancelled") {
            const hadActiveMessage = activeMessageRef.current || visibleActivityRef.current;
            activeMessageRef.current = false;
            visibleActivityRef.current = false;
            setSending(false);
            setStreamingContent("");
            setStatusMessage("Current message cancelled");

            if (hadActiveMessage) {
              appendTranscriptEntry(setEntries, {
                id: `system-${Date.now()}`,
                role: "system",
                content: "Current message cancelled.",
              });
            }
          }
        },
        onEnd() {
          scheduleReconnect(2000, "Stream disconnected — retrying…");
        },
        onError(error, retryable = true) {
          if (!retryable) {
            if (retryTimer) {
              clearTimeout(retryTimer);
            }
            setConnectionState("disconnected");
            setConnectionId(null);
            setStatusMessage(`Stream failed: ${describeError(error)}`);
            return;
          }

          scheduleReconnect(3000, `Stream error — retrying: ${describeError(error)}`);
        },
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      streamHandle?.close();
    };
  }, [client]);

  const selectedWorkerIndex = selectedWorkerId
    ? Math.max(0, workers.findIndex((worker) => worker.id === selectedWorkerId))
    : -1;
  const selectedWorker = selectedWorkerIndex >= 0 ? workers[selectedWorkerIndex] : null;

  const leftWidth = size.columns >= 140 ? 32 : 26;
  const rightWidth = size.columns >= 140 ? 38 : 32;
  const centerWidth = Math.max(32, size.columns - leftWidth - rightWidth - 6);
  const composerInputWidth = Math.max(12, size.columns - 12);
  const transcriptLineBudget = Math.max(8, size.rows - 13);
  const detailWidth = Math.max(20, rightWidth - 4);
  const centerContentWidth = Math.max(24, centerWidth - 4);

  const { transcriptLines, transcriptTitle } = useMemo(() => {
    const assistantName = effectiveConfig?.assistantDisplayName ?? client.config.identity.assistantDisplayName;
    const lines: TranscriptLine[] = [];

    for (const entry of entries) {
      const label = entry.role === "user"
        ? "you"
        : entry.role === "assistant"
          ? assistantName
          : "system";

      let inCodeBlock = false;
      const wrapped = wrapText(entry.content, Math.max(10, centerContentWidth - label.length - 3));
      wrapped.forEach((line, index) => {
        const pfx = index === 0 ? `${label}> ` : " ".repeat(label.length + 2);
        const trimmedLine = line.trimStart();
        if (trimmedLine.startsWith("```")) {
          inCodeBlock = !inCodeBlock;
        }
        lines.push({
          key: `${entry.id}-${index}`,
          role: entry.role,
          prefix: pfx,
          text: line,
          codeBlock: inCodeBlock && !trimmedLine.startsWith("```"),
        });
      });
      lines.push({
        key: `${entry.id}-gap`,
        role: "system",
        prefix: "",
        text: " ",
      });
    }

    if (streamingContent.trim()) {
      const pfxFirst = `${assistantName}> `;
      const pfxCont = " ".repeat(pfxFirst.length);
      const wrapped = wrapText(streamingContent, Math.max(10, centerContentWidth - pfxFirst.length));
      let inCodeBlock = false;
      wrapped.forEach((line, index) => {
        const trimmedLine = line.trimStart();
        if (trimmedLine.startsWith("```")) {
          inCodeBlock = !inCodeBlock;
        }
        lines.push({
          key: `stream-${index}`,
          role: "assistant",
          prefix: index === 0 ? pfxFirst : pfxCont,
          text: line,
          codeBlock: inCodeBlock && !trimmedLine.startsWith("```"),
        });
      });
    } else if (sending) {
      lines.push({
        key: "stream-pending",
        role: "assistant",
        prefix: `${assistantName}> `,
        text: "Thinking…",
      });
    }

    if (lines.length === 0) {
      lines.push({
        key: "empty",
        role: "system",
        prefix: "",
        text: "No transcript yet. Type a prompt in the composer pane and press Enter.",
      });
    }

    const maxOffset = Math.max(0, lines.length - transcriptLineBudget);
    const clampedOffset = clamp(transcriptScrollOffset, 0, maxOffset);
    const end = lines.length - clampedOffset;
    const start = Math.max(0, end - transcriptLineBudget);
    const linesAbove = start;

    const title = linesAbove > 0
      ? `Transcript [+${linesAbove} above]`
      : "Transcript";

    return { transcriptLines: lines.slice(start, end), transcriptTitle: title };
  }, [centerContentWidth, client.config.identity.assistantDisplayName, effectiveConfig?.assistantDisplayName, entries, sending, streamingContent, transcriptLineBudget, transcriptScrollOffset]);

  const diagnosticsLines = useMemo(() => {
    const lines: string[] = [];
    const assistantName = effectiveConfig?.assistantDisplayName ?? diagnostics?.identity.assistantDisplayName ?? client.config.identity.assistantDisplayName;
    const productName = effectiveConfig?.productName ?? diagnostics?.identity.productName ?? client.config.identity.productName;

    lines.push(`assistant: ${assistantName}`);
    lines.push(`runtime: ${productName}`);
    lines.push(`api: ${client.config.apiBase}`);
    lines.push(`stream: ${connectionState}${connectionId ? ` (${connectionId})` : ""}`);
    lines.push(`route: ${lastRouteSummary}`);

    if (diagnostics) {
      lines.push(`model: ${diagnostics.routing.currentModel}`);
      lines.push(`auto-route: ${diagnostics.routing.autoRouting.enabled ? "on" : "off"}`);
      lines.push(`workers: ${diagnostics.workers.running}/${diagnostics.workers.count} running`);
      lines.push(`memory rss: ${formatBytes(diagnostics.process.memoryUsage.rss)}`);
      lines.push(`uptime: ${diagnostics.process.uptimeSeconds}s`);
    }

    if (selectedWorker) {
      lines.push(" ");
      lines.push(`selected: ${selectedWorker.name}`);
      lines.push(`status: ${selectedWorker.status}`);
      lines.push(`origin: ${selectedWorker.originChannel ?? "unknown"}`);
      lines.push(`elapsed: ${formatElapsed(selectedWorker.elapsedMs)}`);
      lines.push(`cwd: ${selectedWorker.workingDir}`);
      if (selectedWorker.lastOutput) {
        lines.push("last output:");
        lines.push(selectedWorker.lastOutput);
      }
    } else {
      lines.push(" ");
      lines.push("No worker selected.");
    }

    return lines
      .flatMap((line) => wrapText(line, detailWidth))
      .slice(0, Math.max(10, size.rows - 9));
  }, [
    client.config.apiBase,
    client.config.identity.assistantDisplayName,
    client.config.identity.productName,
    connectionId,
    connectionState,
    detailWidth,
    diagnostics,
    effectiveConfig?.assistantDisplayName,
    effectiveConfig?.productName,
    lastRouteSummary,
    selectedWorker,
    size.rows,
  ]);

  useEffect(() => {
    if (transcriptScrollOffset <= 1) {
      setTranscriptScrollOffset(0);
    }
  }, [entries.length, streamingContent]);

  const moveWorkerSelection = (direction: -1 | 1) => {
    if (workers.length === 0) {
      return;
    }

    const currentIndex = selectedWorkerId
      ? Math.max(0, workers.findIndex((worker) => worker.id === selectedWorkerId))
      : 0;
    const nextIndex = clamp(currentIndex + direction, 0, workers.length - 1);
    setSelectedWorkerId(workers[nextIndex]?.id ?? null);
  };

  const handleDraftChange = useCallback((draft: string) => {
    pollingStateRef.current = {
      ...pollingStateRef.current,
      composer: draft,
    };
  }, []);

  const submitPrompt = useCallback(async (rawPrompt: string): Promise<boolean> => {
    const prompt = rawPrompt.trim();
    if (!prompt) {
      return false;
    }

    if (!connectionId) {
      appendTranscriptEntry(setEntries, {
        id: `system-${Date.now()}`,
        role: "system",
        content: "Not connected to the daemon stream yet. Wait for connection and try again.",
      });
      return false;
    }

    const requestId = `user-${Date.now()}`;
    appendTranscriptEntry(setEntries, {
      id: requestId,
      role: "user",
      content: prompt,
    });
    setStreamingContent("");
    setSending(true);
    activeMessageRef.current = true;
    visibleActivityRef.current = true;
    setStatusMessage("Sending prompt…");

    void client.postJson("/message", { prompt, connectionId })
      .then(() => {
        setStatusMessage("Prompt queued");
      })
      .catch((error) => {
        activeMessageRef.current = false;
        visibleActivityRef.current = false;
        setSending(false);
        appendTranscriptEntry(setEntries, {
          id: `system-${Date.now()}`,
          role: "system",
          content: `Failed to send prompt: ${describeError(error)}`,
        });
        setStatusMessage(`Send failed: ${describeError(error)}`);
      });

    return true;
  }, [client, connectionId]);

  const cancelCurrentMessage = async () => {
    if (!activeMessageRef.current && !sending && !streamingContent) {
      setStatusMessage("No active message to cancel");
      return;
    }

    try {
      await client.postJson("/cancel", {});
      setStatusMessage("Cancellation requested");
    } catch (error) {
      appendTranscriptEntry(setEntries, {
        id: `system-${Date.now()}`,
        role: "system",
        content: `Failed to cancel message: ${describeError(error)}`,
      });
      setStatusMessage(`Cancel failed: ${describeError(error)}`);
    }
  };

  useInput((input, key) => {
    if (input === "q" && focus !== "composer" && !key.ctrl && !key.meta) {
      exit();
      return;
    }

    if (key.tab) {
      setFocus((current) => nextFocus(current));
      return;
    }

    if (key.escape) {
      void cancelCurrentMessage();
      return;
    }

    if (focus === "workers") {
      if (key.upArrow) {
        moveWorkerSelection(-1);
        return;
      }

      if (key.downArrow) {
        moveWorkerSelection(1);
        return;
      }
    }

    if (focus === "transcript") {
      if (key.upArrow) {
        setTranscriptScrollOffset((current) => current + 1);
        return;
      }

      if (key.downArrow) {
        setTranscriptScrollOffset((current) => Math.max(0, current - 1));
        return;
      }
    }

  });

  return (
    <Box flexDirection="column" width="100%" height={Math.max(18, size.rows - 1)}>
      <DashboardPanels
        focus={focus}
        workers={workers}
        selectedWorkerId={selectedWorkerId}
        leftWidth={leftWidth}
        rightWidth={rightWidth}
        transcriptTitle={transcriptTitle}
        transcriptLines={transcriptLines}
        diagnosticsLines={diagnosticsLines}
      />

      <ComposerPane
        focus={focus}
        connectionState={connectionState}
        statusMessage={statusMessage}
        inputWidth={composerInputWidth}
        onSubmit={submitPrompt}
        onDraftChange={handleDraftChange}
      />
    </Box>
  );
}
