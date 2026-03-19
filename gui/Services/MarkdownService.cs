using Ganss.Xss;
using Markdig;

namespace AttacheGui.Services;

public class MarkdownService
{
    private readonly MarkdownPipeline _pipeline;
    private readonly HtmlSanitizer _sanitizer;

    public MarkdownService()
    {
        _pipeline = new MarkdownPipelineBuilder()
            .UseAdvancedExtensions()
            .UseGenericAttributes()
            .Build();

        _sanitizer = new HtmlSanitizer();
        _sanitizer.AllowedAttributes.Add("class");
        _sanitizer.AllowedAttributes.Add("open");
        _sanitizer.AllowedSchemes.Add("mailto");
        // Allow collapsible elements for tool call traces
        _sanitizer.AllowedTags.Add("details");
        _sanitizer.AllowedTags.Add("summary");
    }

    public string ToHtml(string markdown)
    {
        if (string.IsNullOrEmpty(markdown)) return "";

        var html = Markdown.ToHtml(markdown, _pipeline);
        return _sanitizer.Sanitize(html);
    }
}
