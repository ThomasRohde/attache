import { Text } from "ink";

interface MarkdownSegment {
  text: string;
  bold?: boolean;
  underline?: boolean;
  dimColor?: boolean;
  inverse?: boolean;
}

function parseInlineMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  // Order matters: code first (greedy), then bold, then emphasis, then strikethrough
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|((?<!\*)\*(?!\*)[^*]+\*(?!\*))|(_[^_]+_)|(~~[^~]+~~)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index) });
    }

    const full = match[0]!;

    if (match[1]) {
      // `code`
      segments.push({ text: full.slice(1, -1), inverse: true });
    } else if (match[2]) {
      // **bold**
      segments.push({ text: full.slice(2, -2), bold: true });
    } else if (match[3]) {
      // *emphasis*
      segments.push({ text: full.slice(1, -1), underline: true });
    } else if (match[4]) {
      // _emphasis_
      segments.push({ text: full.slice(1, -1), underline: true });
    } else if (match[5]) {
      // ~~strikethrough~~
      segments.push({ text: full.slice(2, -2), dimColor: true });
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }

  if (segments.length === 0) {
    segments.push({ text });
  }

  return segments;
}

function isHeaderLine(text: string): { level: number; content: string } | null {
  const match = /^(#{1,3})\s+(.+)$/.exec(text);
  if (!match) return null;
  return { level: match[1]!.length, content: match[2]! };
}

function isListItem(text: string): { marker: string; content: string } | null {
  const match = /^(\s*[-*]\s)(.+)$/.exec(text);
  if (!match) return null;
  return { marker: match[1]!, content: match[2]! };
}

export interface MarkdownTextProps {
  text: string;
  baseColor?: string;
  codeBlock?: boolean;
}

export function MarkdownText({ text, baseColor, codeBlock }: MarkdownTextProps): JSX.Element {
  if (codeBlock) {
    return <Text color="white">{text}</Text>;
  }

  const header = isHeaderLine(text);
  if (header) {
    const segments = parseInlineMarkdown(header.content);
    return (
      <Text color={baseColor} bold underline>
        {segments.map((seg, i) => (
          <Text
            key={i}
            bold
            underline
            inverse={seg.inverse}
            dimColor={seg.dimColor}
          >
            {seg.text}
          </Text>
        ))}
      </Text>
    );
  }

  const listItem = isListItem(text);
  if (listItem) {
    const segments = parseInlineMarkdown(listItem.content);
    return (
      <Text color={baseColor}>
        {listItem.marker}
        {segments.map((seg, i) => (
          <Text
            key={i}
            bold={seg.bold}
            underline={seg.underline}
            inverse={seg.inverse}
            dimColor={seg.dimColor}
          >
            {seg.text}
          </Text>
        ))}
      </Text>
    );
  }

  const segments = parseInlineMarkdown(text);
  if (segments.length === 1 && !segments[0]!.bold && !segments[0]!.underline && !segments[0]!.inverse && !segments[0]!.dimColor) {
    return <Text color={baseColor}>{text}</Text>;
  }

  return (
    <Text color={baseColor}>
      {segments.map((seg, i) => (
        <Text
          key={i}
          bold={seg.bold}
          underline={seg.underline}
          inverse={seg.inverse}
          dimColor={seg.dimColor}
        >
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}
