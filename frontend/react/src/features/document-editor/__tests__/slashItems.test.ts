/**
 * Slash-command item tests (ADR 0334 Phase 2) — the catalog build + the query
 * filter (title OR keyword match, case-insensitive).
 *
 * Sabotage (wave 14): an item's run applies the wrong block or skips the
 * `/query` delete → the run case red; drop the title branch → the title case
 * red; drop the keyword branch → the keyword case red; stop lower-casing the
 * query → the title case red.
 * Ceiling: "all items for an empty query" is double-guarded (`''.includes('')`
 * is true even without the early return), so no single sabotage reds it.
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildSlashItems, filterSlashItems } from '../slashItems.js';
import { documentExtensions } from '../documentSchema.js';

// Identity translator except one real title, so a title match is distinguishable
// from a keyword match (no item's keywords contain "heading 1").
const t = (k: string) => (k === 'document-editor:slash_h1' ? 'Heading 1' : k);

describe('buildSlashItems', () => {
  it('builds the closed block catalog with a run per item', () => {
    expect(buildSlashItems(t).map((i) => i.id)).toEqual(['text', 'h1', 'h2', 'h3', 'bullet', 'ordered', 'quote', 'code', 'divider', 'table']);
  });

  it('each run deletes the slash range then applies its block', () => {
    const h1 = buildSlashItems(t).find((i) => i.id === 'h1')!;
    const editor = new Editor({ element: document.createElement('div'), extensions: documentExtensions(), content: '<p>/h1</p>' });
    try {
      // `/h1` occupies positions 1..4 inside the first paragraph.
      h1.run(editor, { from: 1, to: 4 });
      expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
      expect(editor.state.doc.textContent).toBe('');
    } finally { editor.destroy(); }
  });
});

describe('filterSlashItems', () => {
  const items = buildSlashItems(t);
  it('returns all items for an empty query', () => {
    expect(filterSlashItems(items, '')).toHaveLength(items.length);
  });
  it('matches by title (case-insensitive)', () => {
    expect(filterSlashItems(items, 'HEADING 1').map((i) => i.id)).toEqual(['h1']);
  });
  it('matches by keyword', () => {
    expect(filterSlashItems(items, 'numbered').map((i) => i.id)).toEqual(['ordered']);
    expect(filterSlashItems(items, 'separator').map((i) => i.id)).toEqual(['divider']);
  });
  it('returns nothing for a non-match', () => {
    expect(filterSlashItems(items, 'zzz')).toEqual([]);
  });
});
