/**
 * textDiff (ADR 0069) — the dependency-free line + JSON diff that backs the
 * artifact workbench. Pure functions; server-free.
 */
import { describe, expect, it } from 'vitest';
import { diffText, diffJson } from '../src/host/textDiff.js';

describe('diffText (LCS line diff)', () => {
  it('marks added, removed, and equal lines with original line numbers', () => {
    const d = diffText('a\nb\nc', 'a\nB\nc\nd');
    expect(d.format).toBe('text');
    // a equal, b removed, B added, c equal, d added
    expect(d.lines.map((l) => l.op)).toEqual(['equal', 'remove', 'add', 'equal', 'add']);
    expect(d.removed).toBe(1);
    expect(d.added).toBe(2);
    const equalA = d.lines[0]!;
    expect(equalA.fromLine).toBe(1);
    expect(equalA.toLine).toBe(1);
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
    const byPath = Object.fromEntries(d.changes.map((c) => [c.path, c]));
    expect(byPath['b.c']!.op).toBe('change');
    expect(byPath['b.c']!.before).toBe(2);
    expect(byPath['b.c']!.after).toBe(3);
    expect(byPath['gone']!.op).toBe('remove');
    expect(byPath['added']!.op).toBe('add');
  });

  it('equal JSON yields no changes', () => {
    expect(diffJson({ a: [1, 2] }, { a: [1, 2] }).changes).toEqual([]);
  });
});
