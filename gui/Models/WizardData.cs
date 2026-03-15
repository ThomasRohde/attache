namespace AttacheGui.Models;

public class WizardData
{
    public string AssistantDisplayName { get; set; } = "Attache";
    public string CopilotModel { get; set; } = "claude-sonnet-4.6";
    public string? TelegramBotToken { get; set; }
    public string? AuthorizedUserId { get; set; }
}
