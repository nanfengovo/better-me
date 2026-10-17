/** @jsxRuntime automatic */
import { splitStyledText, type TextStyleRange } from "@better-me/core";

/** All user content remains text nodes; style ranges are validated view metadata. */
export function RichResumeText({ text, ranges }: { text: string; ranges?: TextStyleRange[] }) {
  if (!ranges?.length) return <>{text}</>;
  return <>{splitStyledText(text, ranges).map((segment, index) => {
    const { bold, italic, underline, highlight, fontScale } = segment.style;
    return <span key={index} style={{
      fontWeight: bold ? 700 : bold === false ? 400 : undefined,
      fontStyle: italic ? "italic" : italic === false ? "normal" : undefined,
      textDecoration: underline ? "underline" : underline === false ? "none" : undefined,
      backgroundColor: highlight ? "#fae6a1" : undefined,
      borderRadius: highlight ? "2px" : undefined,
      fontSize: fontScale !== undefined ? `${Math.max(.8, Math.min(1.8, fontScale))}em` : undefined,
    }}>{segment.text}</span>;
  })}</>;
}
