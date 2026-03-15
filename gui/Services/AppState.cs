using AttacheGui.Models;

namespace AttacheGui.Services;

public class AppState
{
    private static readonly string EnvPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".attache", ".env");

    public bool IsFirstRun { get; set; } = !File.Exists(EnvPath);

    public List<WorkerModel> Workers { get; set; } = [];
    public DiagnosticsModel? Diagnostics { get; set; }
    public string? SelectedWorkerId { get; set; }
    public ConnectionState ConnectionState { get; set; } = ConnectionState.Disconnected;
    public string StatusMessage { get; set; } = "Connecting...";
    public List<TranscriptEntry> TranscriptEntries { get; set; } = [];
    public string? StreamingContent { get; set; }
    public WorkfolderInfo? Workfolder { get; set; }
    public bool IsProcessing { get; set; }
    public string? WorkerLogs { get; set; }

    /// <summary>True when viewing orchestrator transcript, false when viewing a worker's logs.</summary>
    public bool ViewingOrchestrator => SelectedWorkerId is null;

    public WorkerModel? SelectedWorker =>
        SelectedWorkerId is not null
            ? Workers.Find(w => w.Id == SelectedWorkerId)
            : null;

    public event Action? OnStateChanged;

    public void NotifyStateChanged() => OnStateChanged?.Invoke();

    public void AddUserMessage(string content, string source = "tui")
    {
        TranscriptEntries.Add(new TranscriptEntry
        {
            Role = "user",
            Content = content,
            Source = source,
            Timestamp = DateTime.Now,
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

    public void HandleCancelled()
    {
        StreamingContent = null;
        IsProcessing = false;
        NotifyStateChanged();
    }
}

public enum ConnectionState
{
    Disconnected,
    Connecting,
    Connected,
}
