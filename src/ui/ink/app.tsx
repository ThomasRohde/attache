import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createDaemonClient,
  type DiagnosticsResponse,
  type EffectiveConfigResponse,
  type WorkerSummary,
} from "../shared/daemon-client.js";

type FocusPane = "workers" | "transcript" | "inspector" | "composer";
type ConnectionState = "connecting" | "connected" | "disconnected";
type TranscriptRole = "user" | "assistant" | "system";

interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  content: string;
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
  const [composer, setComposer] = useState("");
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [statusMessage, setStatusMessage] = useState("Connecting to daemon…");
  const [sending, setSending] = useState(false);
  const [lastRouteSummary, setLastRouteSummary] = useState<string>("No route yet");

  const activeMessageRef = useRef(false);
  const visibleActivityRef = useRef(false);

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
      try {
        const [sessionData, diagnosticsData] = await Promise.all([
          client.getJson<WorkerSummary[]>("/sessions"),
          client.getJson<DiagnosticsResponse>("/diagnostics"),
        ]);

        if (cancelled) {
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
  const transcriptLineBudget = Math.max(8, size.rows - 11);
  const detailWidth = Math.max(20, rightWidth - 4);
  const centerContentWidth = Math.max(24, centerWidth - 4);

  const transcriptLines = useMemo(() => {
    const assistantName = effectiveConfig?.assistantDisplayName ?? client.config.identity.assistantDisplayName;
    const lines: Array<{ key: string; role: TranscriptRole; text: string }> = [];

    for (const entry of entries) {
      const label = entry.role === "user"
        ? "you"
        : entry.role === "assistant"
          ? assistantName
          : "system";

      const wrapped = wrapText(entry.content, Math.max(10, centerContentWidth - label.length - 3));
      wrapped.forEach((line, index) => {
        const prefix = index === 0 ? `${label}> ` : " ".repeat(label.length + 2);
        lines.push({
          key: `${entry.id}-${index}`,
          role: entry.role,
          text: `${prefix}${line}`,
        });
      });
      lines.push({
        key: `${entry.id}-gap`,
        role: "system",
        text: " ",
      });
    }

    if (streamingContent.trim()) {
      const label = `${assistantName}> `;
      const wrapped = wrapText(streamingContent, Math.max(10, centerContentWidth - label.length));
      wrapped.forEach((line, index) => {
        lines.push({
          key: `stream-${index}`,
          role: "assistant",
          text: `${index === 0 ? label : " ".repeat(label.length)}${line}`,
        });
      });
    } else if (sending) {
      lines.push({
        key: "stream-pending",
        role: "assistant",
        text: `${assistantName}> Thinking…`,
      });
    }

    if (lines.length === 0) {
      lines.push({
        key: "empty",
        role: "system",
        text: "No transcript yet. Type a prompt in the composer pane and press Enter.",
      });
    }

    return lines.slice(-transcriptLineBudget);
  }, [centerContentWidth, client.config.identity.assistantDisplayName, effectiveConfig?.assistantDisplayName, entries, sending, streamingContent, transcriptLineBudget]);

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

  const submitPrompt = async () => {
    const prompt = composer.trim();
    if (!prompt) {
      return;
    }

    if (!connectionId) {
      appendTranscriptEntry(setEntries, {
        id: `system-${Date.now()}`,
        role: "system",
        content: "Not connected to the daemon stream yet. Wait for connection and try again.",
      });
      return;
    }

    const requestId = `user-${Date.now()}`;
    appendTranscriptEntry(setEntries, {
      id: requestId,
      role: "user",
      content: prompt,
    });
    setComposer("");
    setStreamingContent("");
    setSending(true);
    activeMessageRef.current = true;
    visibleActivityRef.current = true;
    setStatusMessage("Sending prompt…");

    try {
      await client.postJson("/message", { prompt, connectionId });
      setStatusMessage("Prompt queued");
    } catch (error) {
      activeMessageRef.current = false;
      visibleActivityRef.current = false;
      setSending(false);
      appendTranscriptEntry(setEntries, {
        id: `system-${Date.now()}`,
        role: "system",
        content: `Failed to send prompt: ${describeError(error)}`,
      });
      setStatusMessage(`Send failed: ${describeError(error)}`);
    }
  };

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

    if (focus !== "composer") {
      return;
    }

    if (key.return) {
      void submitPrompt();
      return;
    }

    if (key.backspace || key.delete) {
      setComposer((current) => current.slice(0, -1));
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    if (input.length > 0) {
      setComposer((current) => current + input);
    }
  });

  return (
    <Box flexDirection="column" width="100%" height={Math.max(18, size.rows - 1)}>
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

        <Pane title="Transcript" focused={focus === "transcript"}>
          {transcriptLines.map((line) => (
            <Text key={line.key} color={transcriptColor(line.role)}>
              {line.text}
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

      <Box marginTop={1}>
        <Pane title={`Composer${focus === "composer" ? " [focused]" : ""}`} focused={focus === "composer"}>
          <Text color={connectionState === "connected" ? "green" : connectionState === "connecting" ? "yellow" : "red"}>
            {connectionState === "connected" ? "● connected" : connectionState === "connecting" ? "● connecting" : "● disconnected"}
          </Text>
          <Text>
            {"> "} {composer}
            {focus === "composer" ? "█" : ""}
          </Text>
          <Text dimColor>{statusMessage}</Text>
          <Text dimColor>Tab focus • ↑/↓ select worker • Esc cancel • Enter send • q/Ctrl+C quit • legacy: attache tui:legacy</Text>
        </Pane>
      </Box>
    </Box>
  );
}
