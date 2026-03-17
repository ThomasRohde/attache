using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using AttacheGui.Models;

namespace AttacheGui.Services;

public record StatusResult(bool Running, int WorkerCount, string Summary);

public class ApiClient : IDisposable
{
    private HttpClient _http;
    private HttpClient? _sseClient;
    private string? _token;
    private const int DefaultApiPort = 7777;
    private static readonly TimeSpan PortCacheDuration = TimeSpan.FromSeconds(30);

    private Uri _cachedBaseAddress;
    private DateTime _lastPortResolution;

    private static readonly string TokenPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".attache", "api-token");
    private static readonly string EnvPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".attache", ".env");

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public ApiClient()
    {
        _cachedBaseAddress = ResolveBaseAddress();
        _lastPortResolution = DateTime.UtcNow;
        _http = CreateHttpClient(_cachedBaseAddress, TimeSpan.FromSeconds(5));
        TryLoadToken();
    }

    private static HttpClient CreateHttpClient(Uri baseAddress, TimeSpan timeout)
    {
        return new HttpClient
        {
            BaseAddress = baseAddress,
            Timeout = timeout,
        };
    }

    private void TryLoadToken()
    {
        if (_token is not null) return;
        if (!File.Exists(TokenPath)) return;

        _token = File.ReadAllText(TokenPath).Trim();
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _token);
    }

    private static Uri ResolveBaseAddress()
    {
        var port = DefaultApiPort;

        try
        {
            if (File.Exists(EnvPath))
            {
                foreach (var line in File.ReadLines(EnvPath))
                {
                    if (!line.StartsWith("API_PORT=", StringComparison.Ordinal))
                        continue;

                    var value = line["API_PORT=".Length..].Trim().Trim('"');
                    if (int.TryParse(value, out var parsed) && parsed is >= 1 and <= 65535)
                    {
                        port = parsed;
                    }
                    break;
                }
            }
        }
        catch
        {
            // Fall back to the default port when the env file can't be read.
        }

        return new Uri($"http://127.0.0.1:{port}");
    }

    /// <summary>
    /// Ensure the cached base address is fresh and recreate the HTTP client if the port changed.
    /// BaseAddress is immutable after the first request, so we must create a new HttpClient.
    /// </summary>
    private void RefreshConnection()
    {
        TryLoadToken();

        if (DateTime.UtcNow - _lastPortResolution < PortCacheDuration)
            return;

        var newAddress = ResolveBaseAddress();
        _lastPortResolution = DateTime.UtcNow;

        if (_cachedBaseAddress.ToString() == newAddress.ToString())
            return;

        _cachedBaseAddress = newAddress;

        var oldHttp = _http;
        _http = CreateHttpClient(_cachedBaseAddress, TimeSpan.FromSeconds(5));
        if (_token is not null)
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        oldHttp.Dispose();
    }

    public async Task<StatusResult> GetStatusAsync()
    {
        RefreshConnection();
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
        RefreshConnection();
        try
        {
            var json = await _http.GetStringAsync($"/transcript?limit={limit}");
            return JsonSerializer.Deserialize<List<TranscriptRow>>(json, JsonOpts) ?? [];
        }
        catch { return []; }
    }

    public async Task<List<WorkerModel>> GetSessionsAsync()
    {
        RefreshConnection();
        try
        {
            var json = await _http.GetStringAsync("/sessions");
            return JsonSerializer.Deserialize<List<WorkerModel>>(json, JsonOpts) ?? [];
        }
        catch { return []; }
    }

    public async Task<DiagnosticsModel?> GetDiagnosticsAsync()
    {
        RefreshConnection();
        try
        {
            var json = await _http.GetStringAsync("/diagnostics");
            return JsonSerializer.Deserialize<DiagnosticsModel>(json, JsonOpts);
        }
        catch { return null; }
    }

    public async Task<ConfigModel?> GetConfigAsync()
    {
        RefreshConnection();
        try
        {
            var json = await _http.GetStringAsync("/config/effective");
            return JsonSerializer.Deserialize<ConfigModel>(json, JsonOpts);
        }
        catch { return null; }
    }

    public async Task<CapabilitiesModel?> GetCapabilitiesAsync()
    {
        RefreshConnection();
        try
        {
            var json = await _http.GetStringAsync("/capabilities");
            return JsonSerializer.Deserialize<CapabilitiesModel>(json, JsonOpts);
        }
        catch { return null; }
    }

    public async Task<List<ModelInfo>> GetModelsAsync(string? provider = null)
    {
        RefreshConnection();
        try
        {
            var url = provider is not null ? $"/models?provider={Uri.EscapeDataString(provider)}" : "/models";
            var json = await _http.GetStringAsync(url);
            return JsonSerializer.Deserialize<List<ModelInfo>>(json, JsonOpts) ?? [];
        }
        catch { return []; }
    }

    public async Task<string?> GetWorkerLogsAsync(string workerId)
    {
        RefreshConnection();
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
        RefreshConnection();
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
        RefreshConnection();
        try
        {
            var body = JsonSerializer.Serialize(new { model });
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            var resp = await _http.PostAsync("/model", content);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<string?> GetBackendAsync()
    {
        RefreshConnection();
        try
        {
            var json = await _http.GetStringAsync("/backend");
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("name", out var n) ? n.GetString() : null;
        }
        catch { return null; }
    }

    public async Task<bool> PostBackendAsync(string name)
    {
        RefreshConnection();
        try
        {
            var body = JsonSerializer.Serialize(new { name });
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            var resp = await _http.PostAsync("/backend", content);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<WorkfolderInfo?> GetWorkfolderAsync()
    {
        RefreshConnection();
        try
        {
            var json = await _http.GetStringAsync("/workfolder");
            return JsonSerializer.Deserialize<WorkfolderInfo>(json, JsonOpts);
        }
        catch { return null; }
    }

    public async Task<bool> PostWorkfolderAsync(string path)
    {
        RefreshConnection();
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
        RefreshConnection();
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
        RefreshConnection();

        _sseClient?.Dispose();
        _sseClient = CreateHttpClient(_cachedBaseAddress, Timeout.InfiniteTimeSpan);
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
        RefreshConnection();
        var body = JsonSerializer.Serialize(new { prompt, connectionId });
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        var resp = await _http.PostAsync("/message", content);
        return resp.IsSuccessStatusCode;
    }

    public async Task<bool> PostCancelAsync()
    {
        RefreshConnection();
        try
        {
            var resp = await _http.PostAsync("/cancel", null);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<List<SkillInfo>> GetSkillsAsync()
    {
        RefreshConnection();
        try
        {
            var json = await _http.GetStringAsync("/skills");
            return JsonSerializer.Deserialize<List<SkillInfo>>(json, JsonOpts) ?? [];
        }
        catch { return []; }
    }

    public async Task<List<SkillStats>> GetSkillStatsAsync()
    {
        RefreshConnection();
        try
        {
            var json = await _http.GetStringAsync("/skills/stats");
            return JsonSerializer.Deserialize<List<SkillStats>>(json, JsonOpts) ?? [];
        }
        catch { return []; }
    }

    public async Task<List<CronJob>> GetCronJobsAsync()
    {
        RefreshConnection();
        try
        {
            var json = await _http.GetStringAsync("/cron");
            return JsonSerializer.Deserialize<List<CronJob>>(json, JsonOpts) ?? [];
        }
        catch { return []; }
    }

    public async Task<bool> ToggleCronJobAsync(int id)
    {
        RefreshConnection();
        try
        {
            var resp = await _http.PostAsync($"/cron/{id}/toggle", null);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<bool> DeleteCronJobAsync(int id)
    {
        RefreshConnection();
        try
        {
            var resp = await _http.DeleteAsync($"/cron/{id}");
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<List<CronExecution>> GetCronHistoryAsync(int? jobId = null, int limit = 50)
    {
        RefreshConnection();
        try
        {
            var url = jobId.HasValue
                ? $"/cron/{jobId}/history?limit={limit}"
                : $"/cron/history?limit={limit}";
            var json = await _http.GetStringAsync(url);
            return JsonSerializer.Deserialize<List<CronExecution>>(json, JsonOpts) ?? [];
        }
        catch { return []; }
    }

    public async Task PostRestartAsync()
    {
        RefreshConnection();
        using var req = new HttpRequestMessage(HttpMethod.Post, "/restart");
        await _http.SendAsync(req);
    }

    public void Dispose()
    {
        _http.Dispose();
        _sseClient?.Dispose();
    }
}
