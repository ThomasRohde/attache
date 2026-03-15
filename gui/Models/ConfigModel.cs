using System.Text.Json.Serialization;

namespace AttacheGui.Models;

public class ConfigModel
{
    [JsonPropertyName("productName")]
    public string ProductName { get; set; } = "";

    [JsonPropertyName("assistantDisplayName")]
    public string AssistantDisplayName { get; set; } = "";

    [JsonPropertyName("apiPort")]
    public int ApiPort { get; set; }

    [JsonPropertyName("apiBaseUrl")]
    public string ApiBaseUrl { get; set; } = "";

    [JsonPropertyName("currentModel")]
    public string CurrentModel { get; set; } = "";

    [JsonPropertyName("telegramEnabled")]
    public bool TelegramEnabled { get; set; }
}
