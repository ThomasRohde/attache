using System.Diagnostics;
using System.Text.Json;
using AttacheGui.Models;

namespace AttacheGui.Services;

public class SseService : IDisposable
{
    private readonly ApiClient _api;
    private CancellationTokenSource? _cts;
    private StreamReader? _reader;
    private string? _connectionId;

    public string? ConnectionId => _connectionId;
    public bool IsConnected => _connectionId is not null;

    public event Action? Connected;
    public event Action<string>? DeltaReceived;
    public event Action<string, RouteInfo?>? MessageComplete;
    public event Action? Cancelled;
    public event Action<string, string, string>? TranscriptEntry; // role, content, source
    public event Action<string>? Disconnected;
    public event Action<string>? Error;

    public SseService(ApiClient api)
    {
        _api = api;
    }

    public async Task ConnectAsync()
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        var ct = _cts.Token;

        const int maxRetries = 60;
        const int baseDelayMs = 2000;
        const int maxDelayMs = 30000;

        Console.Error.WriteLine("[SseService] ConnectAsync started");

        for (int attempt = 0; attempt < maxRetries; attempt++)
        {
            if (ct.IsCancellationRequested) return;

            try
            {
                Console.Error.WriteLine($"[SseService] Attempt {attempt + 1}/{maxRetries}");
                var (connectionId, reader) = await _api.OpenSseConnectionAsync(ct);
                _connectionId = connectionId;
                _reader = reader;
                Console.Error.WriteLine($"[SseService] Connected with ID: {connectionId}");
                Connected?.Invoke();

                // Start reading loop
                _ = Task.Run(() => ReadLoopAsync(reader, ct), ct);
                return;
            }
            catch (OperationCanceledException)
            {
                Console.Error.WriteLine("[SseService] Cancelled");
                return;
            }
            catch (Exception ex)
            {
                var delay = Math.Min(baseDelayMs * (1 << Math.Min(attempt, 5)), maxDelayMs);
                Console.Error.WriteLine($"[SseService] Error: {ex.GetType().Name}: {ex.Message}. Retry in {delay}ms");
                Disconnected?.Invoke($"Connection failed: {ex.Message}. Retrying in {delay / 1000}s...");
                try { await Task.Delay(delay, ct); }
                catch (OperationCanceledException) { return; }
            }
        }

        Error?.Invoke("Max reconnection attempts reached.");
    }

    private async Task ReadLoopAsync(StreamReader reader, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(ct);
                if (line is null) break;
                if (!line.StartsWith("data:")) continue;

                var dataJson = line["data:".Length..].Trim();
                try
                {
                    using var doc = JsonDocument.Parse(dataJson);
                    var root = doc.RootElement;
                    var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;

                    switch (type)
                    {
                        case "delta":
                            var deltaContent = root.TryGetProperty("content", out var dc)
                                ? dc.GetString() ?? "" : "";
                            DeltaReceived?.Invoke(deltaContent);
                            break;

                        case "message":
                            var msgContent = root.TryGetProperty("content", out var mc)
                                ? mc.GetString() ?? "" : "";
                            RouteInfo? route = null;
                            if (root.TryGetProperty("route", out var r))
                            {
                                route = JsonSerializer.Deserialize<RouteInfo>(r.GetRawText());
                            }
                            MessageComplete?.Invoke(msgContent, route);
                            break;

                        case "transcript":
                            var tRole = root.TryGetProperty("role", out var tr)
                                ? tr.GetString() ?? "" : "";
                            var tContent = root.TryGetProperty("content", out var tc)
                                ? tc.GetString() ?? "" : "";
                            var tSource = root.TryGetProperty("source", out var ts)
                                ? ts.GetString() ?? "" : "";
                            TranscriptEntry?.Invoke(tRole, tContent, tSource);
                            break;

                        case "cancelled":
                            Cancelled?.Invoke();
                            break;
                    }
                }
                catch { }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Disconnected?.Invoke($"SSE stream ended: {ex.Message}");
        }

        _connectionId = null;

        // Auto-reconnect unless cancelled
        if (!ct.IsCancellationRequested)
        {
            Disconnected?.Invoke("Connection lost. Reconnecting...");
            await Task.Delay(2000, CancellationToken.None);
            if (!ct.IsCancellationRequested)
                await ConnectAsync();
        }
    }

    public void Disconnect()
    {
        _cts?.Cancel();
        _reader?.Dispose();
        _reader = null;
        _connectionId = null;
    }

    public void Dispose()
    {
        Disconnect();
        _cts?.Dispose();
    }
}
