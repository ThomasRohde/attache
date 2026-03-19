using System.Text.Json;
using AttacheGui.Models;

namespace AttacheGui.Services;

public class AppState
{
    private static readonly string EnvPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".attache", ".env");

    private static readonly string GuiSettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".attache", "gui-settings.json");

    public bool IsFirstRun { get; set; } = !File.Exists(EnvPath);

    // GUI-local preferences (persisted to gui-settings.json)
    private bool _showToolTraces = true;
    public bool ShowToolTraces
    {
        get => _showToolTraces;
        set { _showToolTraces = value; SaveGuiSettings(); NotifyStateChanged(); }
    }

    public List<WorkerModel> Workers { get; set; } = [];
    public DiagnosticsModel? Diagnostics { get; set; }
    public string? SelectedWorkerId { get; set; }
    public ConnectionState ConnectionState { get; set; } = ConnectionState.Disconnected;
    public string StatusMessage { get; set; } = "Connecting...";
    public List<TranscriptEntry> TranscriptEntries { get; set; } = [];
    public string? StreamingContent { get; set; }
    public WorkfolderInfo? Workfolder { get; set; }
    public CapabilitiesModel? Capabilities { get; set; }
    public List<SkillInfo> Skills { get; set; } = [];
    public List<SkillStats> SkillStats { get; set; } = [];
    public bool IsProcessing { get; set; }
    public string? WorkerLogs { get; set; }

    // Cron
    public List<CronJob> CronJobs { get; set; } = [];
    public List<CronExecution> CronExecutions { get; set; } = [];
    public int? SelectedCronJobId { get; set; }

    // Channel tabs
    public string SelectedChannel { get; set; } = "tui";
    public HashSet<string> KnownChannels { get; } = new() { "tui" };
    public HashSet<string> UnreadChannels { get; } = new();

    /// <summary>True when viewing orchestrator transcript, false when viewing a worker's logs.</summary>
    public bool ViewingOrchestrator => SelectedWorkerId is null;

    public WorkerModel? SelectedWorker =>
        SelectedWorkerId is not null
            ? Workers.Find(w => w.Id == SelectedWorkerId)
            : null;

    public event Action? OnStateChanged;

    public void NotifyStateChanged() => OnStateChanged?.Invoke();

    public void AddUserMessage(string content, string source = "tui", List<AttachmentInfo>? attachments = null)
    {
        TranscriptEntries.Add(new TranscriptEntry
        {
            Role = "user",
            Content = content,
            Source = source,
            Timestamp = DateTime.Now,
            Attachments = attachments,
        });
        IsProcessing = true;
        NotifyStateChanged();
    }

    public void UpdateStreamingContent(string content)
    {
        StreamingContent = content;
        NotifyStateChanged();
    }

    public void FinalizeAssistantMessage(string content, RouteInfo? route = null)
    {
        StreamingContent = null;
        IsProcessing = false;
        TranscriptEntries.Add(new TranscriptEntry
        {
            Role = "assistant",
            Content = content,
            Timestamp = DateTime.Now,
            Route = route,
        });
        NotifyStateChanged();
    }

    public void AddTranscriptEntry(string role, string content, string source)
    {
        TranscriptEntries.Add(new TranscriptEntry
        {
            Role = role,
            Content = content,
            Source = source,
            Timestamp = DateTime.Now,
        });
        NotifyStateChanged();
    }

    public void HandleCancelled()
    {
        StreamingContent = null;
        IsProcessing = false;
        NotifyStateChanged();
    }

    public void HandleSendFailure(string content)
    {
        StreamingContent = null;
        IsProcessing = false;
        TranscriptEntries.Add(new TranscriptEntry
        {
            Role = "assistant",
            Content = content,
            Source = "tui",
            Timestamp = DateTime.Now,
        });
        RecordChannelActivity("tui");
    }

    public void SelectChannel(string source)
    {
        SelectedChannel = source;
        UnreadChannels.Remove(source);
        NotifyStateChanged();
    }

    public void RecordChannelActivity(string source)
    {
        if (string.IsNullOrEmpty(source)) return;
        KnownChannels.Add(source);
        if (source != SelectedChannel)
            UnreadChannels.Add(source);
        NotifyStateChanged();
    }

    public void ClearTranscript()
    {
        TranscriptEntries.Clear();
        StreamingContent = null;
        IsProcessing = false;
        UnreadChannels.Clear();
        NotifyStateChanged();
    }

    // --- GUI Settings Persistence ---

    public void LoadGuiSettings()
    {
        try
        {
            if (File.Exists(GuiSettingsPath))
            {
                var json = File.ReadAllText(GuiSettingsPath);
                var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("showToolTraces", out var val))
                    _showToolTraces = val.GetBoolean();
            }
        }
        catch { /* use defaults */ }
    }

    private void SaveGuiSettings()
    {
        try
        {
            var dir = Path.GetDirectoryName(GuiSettingsPath);
            if (dir != null) Directory.CreateDirectory(dir);
            var json = JsonSerializer.Serialize(new { showToolTraces = _showToolTraces });
            File.WriteAllText(GuiSettingsPath, json);
        }
        catch { /* best-effort */ }
    }
}

public enum ConnectionState
{
    Disconnected,
    Connecting,
    Connected,
}
