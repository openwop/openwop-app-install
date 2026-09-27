/**
 * The `canvas.document` editor schema (ADR 0334 Phase 1 + 2b) — the ONE closed
 * set of TipTap/ProseMirror extensions, shared by the editable surface AND the
 * read-only renderer so authored content and rendered content can never drift.
 * Phase 1: StarterKit core (paragraphs, headings 1–6, bold/italic/strike/code,
 * bullet/ordered lists, blockquote, code block, horizontal rule, links).
 * Phase 2b: tables (resizable, with header rows) + images (a tenant-scoped Media
 * asset URL — never a remote/guessable src). Math/chart/embed → 2b-2.
 */
import { StarterKit } from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { Image } from '@tiptap/extension-image';
import { MathBlock } from './mathBlock.js';
import { ChartBlock } from './chartBlock.js';
import { EmbedBlock } from './embedBlock.js';
import { CommentMark } from './commentMark.js';
import { InsertionMark, DeletionMark } from './trackChangeMarks.js';
import { generateJSON, type Extensions, type JSONContent } from '@tiptap/core';

/** The closed extension set. `history` is included for the editor's own
 *  intra-document undo/redo (ADR 0334 undo-ownership rule — the chassis undo is
 *  suppressed for EditorSurface types); it is inert for the read-only renderer.
 *  Pass `{ history: false }` when real-time collaboration is on (ADR 0335) — the
 *  y-prosemirror `yUndoPlugin` owns per-user undo then; a global prosemirror
 *  history would let one user undo another's edits. */
export function documentExtensions(opts?: { history?: boolean }): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      ...(opts?.history === false ? { history: false } : {}),
    }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    // `alt` is authored; the `src` is always a tenant-scoped Media asset URL
    // (chosen via MediaPickerDialog) — the A2UI media-token discipline, no
    // remote/guessable URLs.
    Image.configure({ inline: false, allowBase64: false }),
    // Display math (KaTeX); inserted/edited via the surface's LaTeX modal.
    MathBlock,
    // Data chart (inline-SVG `ChartRenderer`) + sandboxed HTML embed (isolated
    // iframe) — inserted/edited via the surface's chart/embed modals (2b-3).
    ChartBlock,
    EmbedBlock,
    // Inline comment anchor (6b) — a range mark carrying a thread id.
    CommentMark,
    // Track-changes suggestion marks (6b-2) — in the shared schema so the
    // read-only renderer shows suggestions; the tracking PLUGIN is editable-only
    // (added in the surface, like the slash menu).
    InsertionMark,
    DeletionMark,
  ];
}

/**
 * Convert an HTML string into a `canvas.document` ProseMirror JSON node against
 * THIS closed schema (ADR 0350 Phase 3). `generateJSON` drops any unknown/script
 * markup, so HTML that doesn't map to the schema simply doesn't survive — no XSS
 * reaches the canvas (the same guarantee the DOCX import relies on). The single
 * owner of the html→document conversion, so a consumer feature (e.g. `documents`
 * "promote to rich document") never imports the TipTap schema itself — it
 * lazy-imports this helper.
 */
export function htmlToDocumentJson(html: string): JSONContent {
  return generateJSON(html, documentExtensions()) as JSONContent;
}
