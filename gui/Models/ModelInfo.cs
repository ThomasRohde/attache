using System.Text.Json.Serialization;

namespace AttacheGui.Models;

public class ModelInfo
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("multiplier")]
    public double Multiplier { get; set; }

    public string DisplayLabel => Multiplier > 0
        ? $"{Name} ({Multiplier}x)"
        : Multiplier == 0
            ? $"{Name} (included)"
            : Name;
}
