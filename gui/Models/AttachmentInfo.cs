namespace AttacheGui.Models;

public class AttachmentInfo
{
    public string OriginalPath { get; set; } = "";
    public string StagedPath { get; set; } = "";
    public string FileName { get; set; } = "";
    public bool IsImage { get; set; }
    public string? ThumbnailDataUri { get; set; }
}
