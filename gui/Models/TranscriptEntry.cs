using System.Text.Json.Serialization;

namespace AttacheGui.Models;

public class TranscriptEntry
{
    public string Role { get; set; } = ""; // "user" or "assistant"
    public string Content { get; set; } = "";
    public string Source { get; set; } = "tui";
    public DateTime Timestamp { get; set; } = DateTime.Now;
    public RouteInfo? Route { get; set; }
}

public class RouteInfo
{
    [JsonPropertyName("model")]
    public string? Model { get; set; }

    [JsonPropertyName("routerMode")]
    public string? RouterMode { get; set; }

    [JsonPropertyName("tier")]
    public string? Tier { get; set; }
}

/// <summary>Row from GET /transcript (conversation_log table).</summary>
public class TranscriptRow
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("role")]
    public string Role { get; set; } = "";

    [JsonPropertyName("content")]
    public string Content { get; set; } = "";

    [JsonPropertyName("source")]
    public string Source { get; set; } = "";

    [JsonPropertyName("ts")]
    public string Ts { get; set; } = "";
}
