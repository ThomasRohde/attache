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
            .DisableHtml()
            .Build();

        _sanitizer = new HtmlSanitizer();
        _sanitizer.AllowedAttributes.Add("class");
        _sanitizer.AllowedSchemes.Add("mailto");
    }

    public string ToHtml(string markdown)
    {
        if (string.IsNullOrEmpty(markdown)) return "";

        var html = Markdown.ToHtml(markdown, _pipeline);
        return _sanitizer.Sanitize(html);
    }
}
