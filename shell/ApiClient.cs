using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace AttacheShell;

public record StatusResult(bool Running, int WorkerCount, string Summary);

public class ApiClient : IDisposable
{
    private readonly HttpClient _http;
    private HttpClient? _sseClient;
    private string? _token;
    private const string BaseUrl = "http://127.0.0.1:7777";

    private static readonly string TokenPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".attache", "api-token");

    public ApiClient()
    {
        _http = new HttpClient
        {
            BaseAddress = new Uri(BaseUrl),
            Timeout = TimeSpan.FromSeconds(5),
        };
        TryLoadToken();
    }

    /// <summary>
    /// Re-reads the token file on each call until it is found.
    /// The daemon creates api-token on first start, so the tray app may
    /// launch before the file exists.
    /// </summary>
    private void TryLoadToken()
    {
        if (_token is not null) return;
        if (!File.Exists(TokenPath)) return;

        _token = File.ReadAllText(TokenPath).Trim();
        var header = new AuthenticationHeaderValue("Bearer", _token);
        _http.DefaultRequestHeaders.Authorization = header;
    }

    /// <summary>GET /status — no auth required.</summary>
    public async Task<StatusResult> GetStatusAsync()
    {
        try
        {
            var json = await _http.GetStringAsync("/status");
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var workers = root.TryGetProperty("workers", out var w) ? w.GetArrayLength() : 0;
            var summary = workers == 0 ? "idle" : $"{workers} worker{(workers == 1 ? "" : "s")} active";
            return new StatusResult(true, workers, summary);
        }
        catch
        {
            return new StatusResult(false, 0, "daemon not running");
        }
    }

    /// <summary>POST /restart — triggers daemon's own graceful restart.</summary>
    public async Task PostRestartAsync()
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/restart");
        await _http.SendAsync(req);
    }

    /// <summary>
    /// Opens a long-lived SSE connection to GET /stream.
    /// Reads until the session.connected event, then returns the connectionId and reader.
    /// The caller must dispose the reader when done.
    /// </summary>
    public async Task<(string connectionId, StreamReader reader)> OpenSseConnectionAsync(CancellationToken ct)
    {
        // Re-check for the token each attempt — daemon may have just created it
        TryLoadToken();

        // Replace any previous SSE client (clean up the old connection)
        _sseClient?.Dispose();
        _sseClient = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        _sseClient.BaseAddress = new Uri(BaseUrl);
        if (_token is not null)
            _sseClient.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", _token);

        var response = await _sseClient.GetAsync(
            "/stream", HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();

        var stream = await response.Content.ReadAsStreamAsync(ct);
        var reader = new StreamReader(stream);

        string? connectionId = null;
        while (!ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is null) break;
            if (!line.StartsWith("data:")) continue;

            var dataJson = line["data:".Length..].Trim();
            try
            {
                using var doc = JsonDocument.Parse(dataJson);
                if (doc.RootElement.TryGetProperty("type", out var type) &&
                    type.GetString() == "connected" &&
                    doc.RootElement.TryGetProperty("connectionId", out var cid))
                {
                    connectionId = cid.GetString();
                    break;
                }
            }
            catch { /* skip malformed lines */ }
        }

        if (connectionId is null)
            throw new InvalidOperationException(
                "Did not receive connectionId from /stream. Is the daemon running?");

        return (connectionId, reader);
    }

    /// <summary>POST /message — prompt is queued; response arrives via the SSE reader.</summary>
    public async Task<bool> SendMessageAsync(string prompt, string connectionId)
    {
        var body = JsonSerializer.Serialize(new { prompt, connectionId });
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        var resp = await _http.PostAsync("/message", content);
        return resp.IsSuccessStatusCode;
    }

    public void Dispose()
    {
        _http.Dispose();
        _sseClient?.Dispose();
    }
}
