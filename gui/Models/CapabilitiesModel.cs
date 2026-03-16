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

    [JsonPropertyName("backend")]
    public CapBackend? Backend { get; set; }

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
}

public class CapFeatures
{
    [JsonPropertyName("telegram")]
    public bool Telegram { get; set; }

    [JsonPropertyName("selfEdit")]
    public bool SelfEdit { get; set; }
}

public class CapBackend
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("capabilities")]
    public CapBackendCapabilities? Capabilities { get; set; }
}

public class CapBackendCapabilities
{
    [JsonPropertyName("customTools")]
    public bool CustomTools { get; set; }

    [JsonPropertyName("sessionResume")]
    public bool SessionResume { get; set; }

    [JsonPropertyName("infiniteSessions")]
    public bool InfiniteSessions { get; set; }

    [JsonPropertyName("persistentClient")]
    public bool PersistentClient { get; set; }

    [JsonPropertyName("modelListing")]
    public bool ModelListing { get; set; }

    [JsonPropertyName("skillDirectories")]
    public bool SkillDirectories { get; set; }

    [JsonPropertyName("structuredOutput")]
    public bool StructuredOutput { get; set; }

    [JsonPropertyName("machineSessionDiscovery")]
    public bool MachineSessionDiscovery { get; set; }
}
