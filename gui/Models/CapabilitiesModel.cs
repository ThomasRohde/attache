using System.Text.Json.Serialization;

namespace AttacheGui.Models;

public class CapabilitiesModel
{
    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; }

    [JsonPropertyName("identity")]
    public CapIdentity? Identity { get; set; }

    [JsonPropertyName("slashCommands")]
    public List<SlashCommand> SlashCommands { get; set; } = [];

    [JsonPropertyName("tools")]
    public List<ToolInfo> Tools { get; set; } = [];

    [JsonPropertyName("model")]
    public CapModelInfo? Model { get; set; }

    [JsonPropertyName("features")]
    public CapFeatures? Features { get; set; }
}

public class CapIdentity
{
    [JsonPropertyName("productName")]
    public string ProductName { get; set; } = "";

    [JsonPropertyName("assistantDisplayName")]
    public string AssistantDisplayName { get; set; } = "";
}

public class SlashCommand
{
    [JsonPropertyName("command")]
    public string Command { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("usage")]
    public string? Usage { get; set; }

    [JsonPropertyName("source")]
    public string? Source { get; set; }
}

public class ToolInfo
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    [JsonPropertyName("category")]
    public string Category { get; set; } = "";
}

public class CapModelInfo
{
    [JsonPropertyName("current")]
    public string Current { get; set; } = "";

    [JsonPropertyName("autoRouting")]
    public CapAutoRouting? AutoRouting { get; set; }
}

public class CapAutoRouting
{
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; }

    [JsonPropertyName("tierModels")]
    public Dictionary<string, string>? TierModels { get; set; }
}

public class CapFeatures
{
    [JsonPropertyName("telegram")]
    public bool Telegram { get; set; }

    [JsonPropertyName("selfEdit")]
    public bool SelfEdit { get; set; }

    [JsonPropertyName("autoRouting")]
    public bool AutoRouting { get; set; }
}
