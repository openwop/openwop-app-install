/**
 * Slash-command item tests (ADR 0334 Phase 2) — the catalog build + the query
 * filter (title OR keyword match, case-insensitive).
 */
import { describe, it, expect } from 'vitest';
import { buildSlashItems, filterSlashItems } from '../slashItems.js';

const t = (k: string) => k; // identity translator

describe('buildSlashItems', () => {
  it('builds the closed block catalog with a run per item', () => {
    const items = buildSlashItems(t);
    expect(items.map((i) => i.id)).toEqual(['text', 'h1', 'h2', 'h3', 'bullet', 'ordered', 'quote', 'code', 'divider', 'table']);
    for (const it of items) expect(typeof it.run).toBe('function');
  });

  it('each run deletes the slash range then applies its block', () => {
    const items = buildSlashItems(t);
    const h1 = items.find((i) => i.id === 'h1')!;
    const calls: string[] = [];
    const chain = {
      focus() { calls.push('focus'); return chain; },
      deleteRange() { calls.push('deleteRange'); return chain; },
      toggleHeading(a: { level: number }) { calls.push(`h${a.level}`); return chain; },
      run() { calls.push('run'); return true; },
    };
    const editor = { chain: () => chain } as never;
    h1.run(editor, { from: 0, to: 1 } as never);
    expect(calls).toEqual(['focus', 'deleteRange', 'h1', 'run']);
  });
});

describe('filterSlashItems', () => {
  const items = buildSlashItems(t);
  it('returns all items for an empty query', () => {
    expect(filterSlashItems(items, '')).toHaveLength(items.length);
  });
  it('matches by title (case-insensitive)', () => {
    expect(filterSlashItems(items, 'H1').map((i) => i.id)).toContain('h1');
  });
  it('matches by keyword', () => {
    expect(filterSlashItems(items, 'ul').map((i) => i.id)).toContain('bullet');
    expect(filterSlashItems(items, 'numbered').map((i) => i.id)).toContain('ordered');
  });
  it('returns nothing for a non-match', () => {
    expect(filterSlashItems(items, 'zzz')).toEqual([]);
  });
});
