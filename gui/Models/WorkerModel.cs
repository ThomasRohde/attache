using System.Text.Json.Serialization;

namespace AttacheGui.Models;

public class WorkerModel
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("workingDir")]
    public string WorkingDir { get; set; } = "";

    [JsonPropertyName("status")]
    public string Status { get; set; } = "idle";

    [JsonPropertyName("originChannel")]
    public string? OriginChannel { get; set; }

    [JsonPropertyName("startedAt")]
    public long? StartedAt { get; set; }

    [JsonPropertyName("elapsedMs")]
    public long? ElapsedMs { get; set; }

    [JsonPropertyName("lastOutput")]
    public string? LastOutput { get; set; }
}
