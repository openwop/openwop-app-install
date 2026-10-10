/**
 * Display-headline emphasis for CMS section headings.
 *
 * openwop.dev sets one word or phrase of each display headline in clay italic
 * (`Open-source orchestration for multi-agent <em>workflows.</em>`). A CMS
 * heading is a plain string, so it marks that span with SINGLE asterisks:
 *
 *   `Build workflows you can watch, pause, and *rewind.*`
 *
 * That is the whole syntax. No other markdown, no HTML, and the output is
 * React elements (never `dangerouslySetInnerHTML`, ADR 0009). A run is matched
 * only when it is non-empty, does not start or end with whitespace, and is not
 * part of a `**double**` run, so `**bold**`, `2 * 3`, and a lone `*` all render
 * literally. Matched markers never reach the DOM: the heading's text content
 * (what prerender, aria and the docs TOC read) is the text without them.
 */
import type { ReactNode } from 'react';

export type HeadingPart = { text: string; em: boolean };

/** `*run*` — no adjacent `*` either side, no edge whitespace inside. */
const EMPHASIS = /(?<!\*)\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)/g;

/** Split a heading into plain and emphasized runs. */
export function parseHeadingEmphasis(text: string): HeadingPart[] {
  const parts: HeadingPart[] = [];
  let last = 0;
  for (const m of text.matchAll(EMPHASIS)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at), em: false });
    parts.push({ text: m[1] ?? '', em: true });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), em: false });
  return parts;
}

/** The heading as plain text, matched markers removed (ids, aria-labels). */
export function stripHeadingEmphasis(text: string): string {
  return parseHeadingEmphasis(text).map((p) => p.text).join('');
}

/** Render a heading string, emphasized runs as `<em>`. */
export function HeadingText({ text }: { text: string }): JSX.Element {
  const nodes: ReactNode[] = parseHeadingEmphasis(text).map((p, i) =>
    p.em ? <em key={i} className="fp-em">{p.text}</em> : p.text,
  );
  return <>{nodes}</>;
}
