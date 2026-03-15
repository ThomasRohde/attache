import { Text, useInput } from "ink";
import { memo, useEffect, useMemo, useState } from "react";

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function calculateViewport(
  value: string,
  cursorOffset: number,
  width: number,
  reserveCursorSpace: boolean,
): { visibleValue: string; cursorIndex: number } {
  const safeWidth = Math.max(1, width);
  const visibleWidth = Math.max(1, safeWidth - (reserveCursorSpace ? 1 : 0));
  const clampedCursorOffset = clamp(cursorOffset, 0, value.length);

  if (value.length <= visibleWidth) {
    return {
      visibleValue: value,
      cursorIndex: clampedCursorOffset,
    };
  }

  let start = clamp(
    clampedCursorOffset - visibleWidth + 1,
    0,
    Math.max(0, value.length - visibleWidth),
  );
  let end = start + visibleWidth;

  if (end > value.length) {
    end = value.length;
    start = Math.max(0, end - visibleWidth);
  }

  return {
    visibleValue: value.slice(start, end),
    cursorIndex: clamp(clampedCursorOffset - start, 0, end - start),
  };
}

export interface InlineTextInputProps {
  value: string;
  placeholder?: string;
  focus?: boolean;
  width: number;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void | Promise<void>;
}

export const InlineTextInput = memo(function InlineTextInput({
  value,
  placeholder = "",
  focus = true,
  width,
  onChange,
  onSubmit,
}: InlineTextInputProps): JSX.Element {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  useEffect(() => {
    setCursorOffset((current) => clamp(current, 0, value.length));
  }, [value]);

  useInput((input, key) => {
    if (
      key.upArrow ||
      key.downArrow ||
      key.tab ||
      key.escape ||
      (key.ctrl && input === "c")
    ) {
      return;
    }

    if (key.return) {
      void onSubmit?.(value);
      return;
    }

    if (key.leftArrow) {
      setCursorOffset((current) => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setCursorOffset((current) => Math.min(value.length, current + 1));
      return;
    }

    if (key.backspace) {
      if (cursorOffset === 0) {
        return;
      }

      const nextOffset = cursorOffset - 1;
      onChange(value.slice(0, nextOffset) + value.slice(cursorOffset));
      setCursorOffset(nextOffset);
      return;
    }

    if (key.delete) {
      if (cursorOffset >= value.length) {
        return;
      }

      onChange(value.slice(0, cursorOffset) + value.slice(cursorOffset + 1));
      return;
    }

    if (key.ctrl || key.meta || input.length === 0) {
      return;
    }

    const nextValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
    onChange(nextValue);
    setCursorOffset(cursorOffset + input.length);
  }, { isActive: focus });

  const rendered = useMemo(() => {
    const safeWidth = Math.max(1, width);

    if (value.length === 0) {
      const clippedPlaceholder = placeholder.slice(0, safeWidth);

      if (!focus) {
        return clippedPlaceholder.length > 0
          ? (
            <Text dimColor wrap="truncate-end">
              {clippedPlaceholder}
            </Text>
          )
          : (
            <Text wrap="truncate-end"> </Text>
          );
      }

      if (clippedPlaceholder.length === 0) {
        return (
          <Text wrap="truncate-end">
            <Text inverse> </Text>
          </Text>
        );
      }

      return (
        <Text wrap="truncate-end">
          <Text inverse>{clippedPlaceholder[0]}</Text>
          <Text dimColor>{clippedPlaceholder.slice(1)}</Text>
        </Text>
      );
    }

    const { visibleValue, cursorIndex } = calculateViewport(
      value,
      cursorOffset,
      safeWidth,
      focus && cursorOffset >= value.length,
    );

    if (!focus) {
      return <Text wrap="truncate-end">{visibleValue || " "}</Text>;
    }

    const beforeCursor = visibleValue.slice(0, cursorIndex);
    const cursorCharacter = visibleValue[cursorIndex] ?? " ";
    const afterCursor = cursorIndex < visibleValue.length
      ? visibleValue.slice(cursorIndex + 1)
      : "";

    return (
      <Text wrap="truncate-end">
        {beforeCursor}
        <Text inverse>{cursorCharacter}</Text>
        {afterCursor}
      </Text>
    );
  }, [cursorOffset, focus, placeholder, value, width]);

  return rendered;
});
