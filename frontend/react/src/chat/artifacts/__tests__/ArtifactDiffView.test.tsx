/**
 * ArtifactDiffView (ADR 0069) — renders a server-computed diff of two immutable
 * artifact revisions: a line view for text (add/remove summary + per-line op and
 * text), a path/op/before/after table for JSON, and designed empty states for
 * no-change in both formats.
 *
 * The text fixture is deliberately ASYMMETRIC (2 added, 1 removed) so a swapped
 * count cannot pass (grade-tests w45: a 1/1 fixture could not tell them apart).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ArtifactDiffView } from '../ArtifactDiffView.js';
import type { TextDiff, JsonDiff } from '../artifactClient.js';

afterEach(cleanup);

describe('ArtifactDiffView', () => {
  it('renders a text diff with an add/remove summary and per-line ops', () => {
    const diff: TextDiff = {
      format: 'text', added: 2, removed: 1,
      lines: [
        { op: 'equal', fromLine: 1, toLine: 1, text: 'a' },
        { op: 'remove', fromLine: 2, text: 'b' },
        { op: 'add', toLine: 2, text: 'B' },
        { op: 'add', toLine: 3, text: 'C' },
      ],
    };
    const { container } = render(<ArtifactDiffView diff={diff} />);
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Diff: 2 added, 1 removed' })).toBeTruthy();
    const lineText = (op: string): string[] =>
      [...container.querySelectorAll(`.artifact-diff__line--${op}`)].map((l) => l.textContent ?? '');
    // gutter glyph + sr-only op label + the line's own text + newline.
    expect(lineText('add')).toEqual(['+Added: B\n', '+Added: C\n']);
    expect(lineText('remove')).toEqual(['−Removed: b\n']);
    expect(lineText('equal')).toEqual([' a\n']);
  });

  it('renders a JSON diff as a path/op/before/after table', () => {
    const diff: JsonDiff = {
      format: 'json',
      changes: [
        { path: 'b.c', op: 'change', before: 2, after: 3 },
        { path: 'd', op: 'add', after: 'new' },
      ],
    };
    const { container } = render(<ArtifactDiffView diff={diff} />);
    const rows = [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    expect(rows).toEqual([
      ['b.c', 'change', '2', '3'],
      ['d', 'add', '—', '"new"'],
    ]);
  });

  it('shows a designed empty state when nothing changed (text and JSON)', () => {
    render(<ArtifactDiffView diff={{ format: 'text', added: 0, removed: 0, lines: [] }} />);
    expect(screen.getByText('No changes between these revisions.')).toBeTruthy();
    cleanup();
    render(<ArtifactDiffView diff={{ format: 'json', changes: [] }} />);
    expect(screen.getByText('No structural changes.')).toBeTruthy();
  });
});
