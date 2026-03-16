using System.Text.Json.Serialization;

namespace AttacheGui.Models;

public class DiagnosticsModel
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = "";

    [JsonPropertyName("api")]
    public ApiDiag? Api { get; set; }

    [JsonPropertyName("process")]
    public ProcessDiag? Process { get; set; }

    [JsonPropertyName("identity")]
    public IdentityDiag? Identity { get; set; }

    [JsonPropertyName("routing")]
    public RoutingDiag? Routing { get; set; }

    [JsonPropertyName("workers")]
    public WorkersDiag? Workers { get; set; }
}

public class ApiDiag
{
    [JsonPropertyName("port")]
    public int Port { get; set; }

    [JsonPropertyName("activeSseConnections")]
    public int ActiveSseConnections { get; set; }
}

public class ProcessDiag
{
    [JsonPropertyName("pid")]
    public int Pid { get; set; }

    [JsonPropertyName("uptimeSeconds")]
    public int UptimeSeconds { get; set; }

    [JsonPropertyName("platform")]
    public string Platform { get; set; } = "";

    [JsonPropertyName("nodeVersion")]
    public string NodeVersion { get; set; } = "";

    [JsonPropertyName("memoryUsage")]
    public MemoryUsageDiag? MemoryUsage { get; set; }
}

public class MemoryUsageDiag
{
    [JsonPropertyName("rss")]
    public long Rss { get; set; }

    [JsonPropertyName("heapTotal")]
    public long HeapTotal { get; set; }

    [JsonPropertyName("heapUsed")]
    public long HeapUsed { get; set; }
}

public class IdentityDiag
{
    [JsonPropertyName("productName")]
    public string ProductName { get; set; } = "";

    [JsonPropertyName("assistantDisplayName")]
    public string AssistantDisplayName { get; set; } = "";
}

public class RoutingDiag
{
    [JsonPropertyName("currentModel")]
    public string CurrentModel { get; set; } = "";

    [JsonPropertyName("activeModel")]
    public string? ActiveModel { get; set; }

    [JsonPropertyName("autoRouting")]
    public AutoRoutingDiag? AutoRouting { get; set; }

    [JsonPropertyName("lastRoute")]
    public LastRouteDiag? LastRoute { get; set; }
}

public class AutoRoutingDiag
{
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; }
}

public class LastRouteDiag
{
    [JsonPropertyName("model")]
    public string? Model { get; set; }

    [JsonPropertyName("routerMode")]
    public string? RouterMode { get; set; }

    [JsonPropertyName("tier")]
    public string? Tier { get; set; }
}

public class WorkersDiag
{
    [JsonPropertyName("count")]
    public int Count { get; set; }

    [JsonPropertyName("running")]
    public int Running { get; set; }

    [JsonPropertyName("items")]
    public List<WorkerModel> Items { get; set; } = [];
}
