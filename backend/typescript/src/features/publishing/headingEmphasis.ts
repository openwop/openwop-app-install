/**
 * CMS display-heading emphasis, crawler side. A heading marks one word or
 * phrase with SINGLE asterisks (`Build workflows you can watch, pause, and
 * *rewind.*`), which the SPA renders as `<em>`. The prerender MUST NOT show the
 * markers: crawler HTML emits the same `<em>`, anchor ids and plain-text
 * fallbacks (meta description) read the text without them.
 *
 * MIRROR: the rule is byte-equal to `EMPHASIS` in
 * `frontend/react/src/features/cms/headingEmphasis.tsx` — a run is matched only
 * when non-empty, without whitespace just inside, and not part of a `**double**`
 * run; `**bold**`, `* x *`, `**` and a lone `*` stay literal.
 */
import { escapeHtml } from './sectionHtml.js';

const EMPHASIS = /(?<!\*)\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)/g;

export type HeadingPart = { text: string; em: boolean };

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

/** The heading as plain text, matched markers removed. */
export function stripHeadingEmphasis(text: string): string {
  return parseHeadingEmphasis(text).map((p) => p.text).join('');
}

/** The heading as escaped HTML, emphasized runs as `<em>`. */
export function headingEmphasisHtml(text: string): string {
  return parseHeadingEmphasis(text).map((p) => (p.em ? `<em>${escapeHtml(p.text)}</em>` : escapeHtml(p.text))).join('');
}
