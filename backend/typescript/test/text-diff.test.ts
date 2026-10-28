/**
 * textDiff (ADR 0069 §Phase 4) — the dependency-free line + JSON diff that
 * backs the artifact-workbench revision compare. Pure functions; server-free.
 *
 * What breaks if this goes red: the workbench mis-renders a revision diff — a
 * wrong op or a wrong original line number puts a change on the wrong line, and
 * a wrong JSON path/before/after shows the user a change that did not happen.
 * Every expectation below is a hand-computed literal, never product output.
 */
import { describe, expect, it } from 'vitest';
import { diffText, diffJson } from '../src/host/textDiff.js';

describe('diffText (LCS line diff)', () => {
  it('marks added, removed, and equal lines with original line numbers', () => {
    const d = diffText('a\nb\nc', 'a\nB\nc\nd');
    expect(d.format).toBe('text');
    // a equal, b removed, B added, c equal, d added — every line's original
    // (from) and new (to) line number, not just the first one.
    expect(d.lines).toEqual([
      { op: 'equal', fromLine: 1, toLine: 1, text: 'a' },
      { op: 'remove', fromLine: 2, text: 'b' },
      { op: 'add', toLine: 2, text: 'B' },
      { op: 'equal', fromLine: 3, toLine: 3, text: 'c' },
      { op: 'add', toLine: 4, text: 'd' },
    ]);
    expect(d.removed).toBe(1);
    expect(d.added).toBe(2);
  });

  it('identical text yields all-equal, zero churn', () => {
    const d = diffText('x\ny', 'x\ny');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.lines.every((l) => l.op === 'equal')).toBe(true);
  });
});

describe('diffJson (structural)', () => {
  it('reports add / remove / change by dotted path', () => {
    const d = diffJson({ a: 1, b: { c: 2 }, gone: true }, { a: 1, b: { c: 3 }, added: 'x' });
    expect(d.format).toBe('json');
    // Exactly three entries: the unchanged `a` is not reported.
    expect(d.changes).toHaveLength(3);
    const byPath = Object.fromEntries(d.changes.map((c) => [c.path, c]));
    expect(byPath['a']).toBeUndefined();
    expect(byPath['b.c']!.op).toBe('change');
    expect(byPath['b.c']!.before).toBe(2);
    expect(byPath['b.c']!.after).toBe(3);
    expect(byPath['gone']!.op).toBe('remove');
    expect(byPath['gone']!.before).toBe(true);
    expect(byPath['added']!.op).toBe('add');
    expect(byPath['added']!.after).toBe('x');
  });

  it('equal JSON yields no changes', () => {
    expect(diffJson({ a: [1, 2] }, { a: [1, 2] }).changes).toEqual([]);
  });
});
