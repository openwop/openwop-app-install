/**
 * ADR 0813 — the CMS prose BLOCK grammar, shared by every `richText` render
 * (public + editor preview). Mirrored server-side in
 * `backend/typescript/src/features/publishing/sectionHtml.ts`; the two cannot
 * share code (separate build targets), so the golden fixture pins them.
 *
 * Blocks are blank-line separated. A lone `### ` line is a subheading; a block
 * whose every line starts `- ` / `* ` is a bullet list, `1. ` / `1) ` a numbered
 * list, `> ` a quote; anything else is a paragraph. The inline grammar inside a
 * block is unchanged, and there is still no raw-HTML path.
 */
export type ProseBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; text: string };

const HEADING_RE = /^###\s+/;
const BULLET_RE = /^[-*]\s+/;
const NUMBERED_RE = /^\d{1,3}[.)]\s+/;
const QUOTE_RE = /^>\s?/;

export function parseProseBlocks(text: string): ProseBlock[] {
  return text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).map((block): ProseBlock => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 1 && HEADING_RE.test(block)) return { kind: 'h3', text: block.replace(HEADING_RE, '') };
    if (lines.every((l) => BULLET_RE.test(l))) return { kind: 'ul', items: lines.map((l) => l.replace(BULLET_RE, '')) };
    if (lines.every((l) => NUMBERED_RE.test(l))) return { kind: 'ol', items: lines.map((l) => l.replace(NUMBERED_RE, '')) };
    if (lines.every((l) => QUOTE_RE.test(l))) return { kind: 'quote', text: lines.map((l) => l.replace(QUOTE_RE, '')).join(' ') };
    return { kind: 'p', text: block };
  });
}
