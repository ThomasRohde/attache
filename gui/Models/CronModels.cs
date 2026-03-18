using System.Text.Json.Serialization;

namespace AttacheGui.Models;

public class CronJob
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("prompt")]
    public string Prompt { get; set; } = "";

    [JsonPropertyName("cron_expression")]
    public string CronExpression { get; set; } = "";

    [JsonPropertyName("enabled")]
    public int EnabledInt { get; set; }

    [JsonIgnore]
    public bool Enabled => EnabledInt != 0;

    [JsonPropertyName("notify_telegram")]
    public int NotifyTelegramInt { get; set; }

    [JsonIgnore]
    public bool NotifyTelegram => NotifyTelegramInt != 0;

    [JsonPropertyName("backend")]
    public string? Backend { get; set; }

    [JsonPropertyName("last_run_at")]
    public string? LastRunAt { get; set; }

    [JsonPropertyName("last_status")]
    public string? LastStatus { get; set; }

    [JsonPropertyName("next_run_at")]
    public string? NextRunAt { get; set; }

    [JsonPropertyName("run_count")]
    public int RunCount { get; set; }

    [JsonPropertyName("created_at")]
    public string? CreatedAt { get; set; }

    [JsonPropertyName("updated_at")]
    public string? UpdatedAt { get; set; }
}

public class CronExecution
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("job_id")]
    public int JobId { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "";

    [JsonPropertyName("result")]
    public string? Result { get; set; }

    [JsonPropertyName("started_at")]
    public string? StartedAt { get; set; }

    [JsonPropertyName("finished_at")]
    public string? FinishedAt { get; set; }

    [JsonPropertyName("duration_ms")]
    public int? DurationMs { get; set; }
}
