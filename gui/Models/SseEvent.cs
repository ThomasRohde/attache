using System.Text.Json.Serialization;

namespace AttacheGui.Models;

public class SseEvent
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("eventName")]
    public string? EventName { get; set; }

    [JsonPropertyName("connectionId")]
    public string? ConnectionId { get; set; }

    [JsonPropertyName("content")]
    public string? Content { get; set; }

    [JsonPropertyName("route")]
    public RouteInfo? Route { get; set; }
}
