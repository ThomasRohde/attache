using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using AttacheGui.Models;

namespace AttacheGui.Services;

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

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public ApiClient()
    {
        _http = new HttpClient
        {
            BaseAddress = new Uri(BaseUrl),
            Timeout = TimeSpan.FromSeconds(5),
        };
        TryLoadToken();
    }

    private void TryLoadToken()
    {
        if (_token is not null) return;
        if (!File.Exists(TokenPath)) return;

        _token = File.ReadAllText(TokenPath).Trim();
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _token);
    }

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

    public async Task<List<TranscriptRow>> GetTranscriptAsync(int limit = 50)
    {
        TryLoadToken();
        try
        {
            var json = await _http.GetStringAsync($"/transcript?limit={limit}");
            return JsonSerializer.Deserialize<List<TranscriptRow>>(json, JsonOpts) ?? [];
        }
        catch { return []; }
    }

    public async Task<List<WorkerModel>> GetSessionsAsync()
    {
        TryLoadToken();
        try
        {
            var json = await _http.GetStringAsync("/sessions");
            return JsonSerializer.Deserialize<List<WorkerModel>>(json, JsonOpts) ?? [];
        }
        catch { return []; }
    }

    public async Task<DiagnosticsModel?> GetDiagnosticsAsync()
    {
        TryLoadToken();
        try
        {
            var json = await _http.GetStringAsync("/diagnostics");
            return JsonSerializer.Deserialize<DiagnosticsModel>(json, JsonOpts);
        }
        catch { return null; }
    }

    public async Task<ConfigModel?> GetConfigAsync()
    {
        TryLoadToken();
        try
        {
            var json = await _http.GetStringAsync("/config/effective");
            return JsonSerializer.Deserialize<ConfigModel>(json, JsonOpts);
        }
        catch { return null; }
    }

    public async Task<CapabilitiesModel?> GetCapabilitiesAsync()
    {
        TryLoadToken();
        try
        {
            var json = await _http.GetStringAsync("/capabilities");
            return JsonSerializer.Deserialize<CapabilitiesModel>(json, JsonOpts);
        }
        catch { return null; }
    }

    public async Task<List<ModelInfo>> GetModelsAsync()
    {
        TryLoadToken();
        try
        {
            var json = await _http.GetStringAsync("/models");
            return JsonSerializer.Deserialize<List<ModelInfo>>(json, JsonOpts) ?? [];
        }
        catch { return []; }
    }

    public async Task<string?> GetWorkerLogsAsync(string workerId)
    {
        TryLoadToken();
        try
        {
            var json = await _http.GetStringAsync($"/workers/{Uri.EscapeDataString(workerId)}/logs?tail=500");
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("logs", out var logs) ? logs.GetString() : null;
        }
        catch { return null; }
    }

    public async Task<string?> GetModelAsync()
    {
        TryLoadToken();
        try
        {
            var json = await _http.GetStringAsync("/model");
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("model", out var m) ? m.GetString() : null;
        }
        catch { return null; }
    }

    public async Task<bool> PostModelAsync(string model)
    {
        TryLoadToken();
        try
        {
            var body = JsonSerializer.Serialize(new { model });
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            var resp = await _http.PostAsync("/model", content);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<bool> PostAutoAsync(bool enabled)
    {
        TryLoadToken();
        try
        {
            var body = JsonSerializer.Serialize(new { enabled });
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            var resp = await _http.PostAsync("/auto", content);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<WorkfolderInfo?> GetWorkfolderAsync()
    {
        TryLoadToken();
        try
        {
            var json = await _http.GetStringAsync("/workfolder");
            return JsonSerializer.Deserialize<WorkfolderInfo>(json, JsonOpts);
        }
        catch { return null; }
    }

    public async Task<bool> PostWorkfolderAsync(string path)
    {
        TryLoadToken();
        try
        {
            var body = JsonSerializer.Serialize(new { path });
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            var resp = await _http.PostAsync("/workfolder", content);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<bool> PostConfigAsync(Dictionary<string, string> values)
    {
        TryLoadToken();
        try
        {
            var body = JsonSerializer.Serialize(values);
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            var resp = await _http.PostAsync("/config", content);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<(string connectionId, StreamReader reader)> OpenSseConnectionAsync(CancellationToken ct)
    {
        TryLoadToken();

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
            catch { }
        }

        if (connectionId is null)
            throw new InvalidOperationException("Did not receive connectionId from /stream.");

        return (connectionId, reader);
    }

    public async Task<bool> SendMessageAsync(string prompt, string connectionId)
    {
        TryLoadToken();
        var body = JsonSerializer.Serialize(new { prompt, connectionId });
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        var resp = await _http.PostAsync("/message", content);
        return resp.IsSuccessStatusCode;
    }

    public async Task<bool> PostCancelAsync()
    {
        TryLoadToken();
        try
        {
            var resp = await _http.PostAsync("/cancel", null);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task PostRestartAsync()
    {
        TryLoadToken();
        using var req = new HttpRequestMessage(HttpMethod.Post, "/restart");
        await _http.SendAsync(req);
    }

    public void Dispose()
    {
        _http.Dispose();
        _sseClient?.Dispose();
    }
}
