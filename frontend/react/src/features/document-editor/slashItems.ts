/**
 * Slash-command items (ADR 0334 Phase 2) — the block-insertion catalog the `/`
 * menu offers. Pure data + a `run` per item; the labels are translated at build
 * time (the surface passes `t`). Each `run` deletes the `/query` range then
 * applies the block, so `/h1<enter>` turns the current line into a heading.
 */
import type { Editor, Range } from '@tiptap/core';

export interface SlashItem {
  id: string;
  title: string;
  hint: string;
  /** Space-joined search terms (matched against the typed query, case-insensitive). */
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

/** Only single-key lookups are used here, so a minimal signature that the
 *  i18next `TFunction` satisfies (avoids the exactOptionalPropertyTypes clash). */
type T = (key: string) => string;

export function buildSlashItems(t: T): SlashItem[] {
  const chain = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);
  return [
    { id: 'text', title: t('document-editor:slash_text'), hint: t('document-editor:slash_text_hint'), keywords: 'text paragraph body',
      run: (e, r) => chain(e, r).setParagraph().run() },
    { id: 'h1', title: t('document-editor:slash_h1'), hint: t('document-editor:slash_h1_hint'), keywords: 'h1 heading title big',
      run: (e, r) => chain(e, r).toggleHeading({ level: 1 }).run() },
    { id: 'h2', title: t('document-editor:slash_h2'), hint: t('document-editor:slash_h2_hint'), keywords: 'h2 heading subtitle',
      run: (e, r) => chain(e, r).toggleHeading({ level: 2 }).run() },
    { id: 'h3', title: t('document-editor:slash_h3'), hint: t('document-editor:slash_h3_hint'), keywords: 'h3 heading',
      run: (e, r) => chain(e, r).toggleHeading({ level: 3 }).run() },
    { id: 'bullet', title: t('document-editor:slash_bullet'), hint: t('document-editor:slash_bullet_hint'), keywords: 'bullet unordered list ul',
      run: (e, r) => chain(e, r).toggleBulletList().run() },
    { id: 'ordered', title: t('document-editor:slash_ordered'), hint: t('document-editor:slash_ordered_hint'), keywords: 'ordered numbered list ol',
      run: (e, r) => chain(e, r).toggleOrderedList().run() },
    { id: 'quote', title: t('document-editor:slash_quote'), hint: t('document-editor:slash_quote_hint'), keywords: 'quote blockquote',
      run: (e, r) => chain(e, r).toggleBlockquote().run() },
    { id: 'code', title: t('document-editor:slash_code'), hint: t('document-editor:slash_code_hint'), keywords: 'code block pre snippet',
      run: (e, r) => chain(e, r).toggleCodeBlock().run() },
    { id: 'divider', title: t('document-editor:slash_divider'), hint: t('document-editor:slash_divider_hint'), keywords: 'divider rule hr separator',
      run: (e, r) => chain(e, r).setHorizontalRule().run() },
    { id: 'table', title: t('document-editor:slash_table'), hint: t('document-editor:slash_table_hint'), keywords: 'table grid rows columns',
      run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  ];
}

/** Filter items by the typed query (matches title OR keywords). */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => it.title.toLowerCase().includes(q) || it.keywords.includes(q));
}
