using System.Text.Json.Serialization;

namespace AttacheGui.Models;

public class SkillInfo
{
    [JsonPropertyName("slug")]
    public string Slug { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    [JsonPropertyName("directory")]
    public string Directory { get; set; } = "";

    [JsonPropertyName("source")]
    public string Source { get; set; } = "";
}

public class SkillStats
{
    [JsonPropertyName("slug")]
    public string Slug { get; set; } = "";

    [JsonPropertyName("total")]
    public int Total { get; set; }

    [JsonPropertyName("successes")]
    public int Successes { get; set; }

    [JsonPropertyName("failures")]
    public int Failures { get; set; }

    [JsonPropertyName("partials")]
    public int Partials { get; set; }

    [JsonPropertyName("lastUsed")]
    public string? LastUsed { get; set; }
}
