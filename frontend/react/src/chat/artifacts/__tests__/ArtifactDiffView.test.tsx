import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ArtifactDiffView } from '../ArtifactDiffView.js';
import type { TextDiff, JsonDiff } from '../artifactClient.js';

afterEach(cleanup);

/** ArtifactDiffView (ADR 0069) — renders a server-computed diff; line view for
 *  text, change table for JSON, designed empty states for no-change. */
describe('ArtifactDiffView', () => {
  it('renders a text diff with an add/remove summary and per-line ops', () => {
    const diff: TextDiff = {
      format: 'text', added: 1, removed: 1,
      lines: [
        { op: 'equal', fromLine: 1, toLine: 1, text: 'a' },
        { op: 'remove', fromLine: 2, text: 'b' },
        { op: 'add', toLine: 2, text: 'B' },
      ],
    };
    render(<ArtifactDiffView diff={diff} />);
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
    expect(screen.getByRole('group', { name: /1 added, 1 removed/ })).toBeTruthy();
  });

  it('renders a JSON diff as a path/op table', () => {
    const diff: JsonDiff = { format: 'json', changes: [{ path: 'b.c', op: 'change', before: 2, after: 3 }] };
    render(<ArtifactDiffView diff={diff} />);
    expect(screen.getByText('b.c')).toBeTruthy();
    expect(screen.getByText('change')).toBeTruthy();
  });

  it('shows a designed empty state when nothing changed', () => {
    render(<ArtifactDiffView diff={{ format: 'text', added: 0, removed: 0, lines: [] }} />);
    expect(screen.getByText(/No changes/)).toBeTruthy();
  });
});
