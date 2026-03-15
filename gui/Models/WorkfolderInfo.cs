using System.Text.Json.Serialization;

namespace AttacheGui.Models;

public class WorkfolderInfo
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = "";

    [JsonPropertyName("gitBranch")]
    public string? GitBranch { get; set; }

    [JsonPropertyName("gitRoot")]
    public string? GitRoot { get; set; }
}
