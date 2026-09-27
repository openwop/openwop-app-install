/**
 * Ambient typing for `markdown-it-footnote` (ships no .d.ts) — a standard
 * MarkdownIt plugin: parses `[^1]` refs + `[^1]: …` definitions into
 * footnote_ref / footnote_block / footnote_open / footnote_close tokens
 * (consumed by the DOCX walker, ADR 0400 P1).
 */
declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const footnotePlugin: (md: MarkdownIt) => void;
  export default footnotePlugin;
}
