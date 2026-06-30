/**
 * CHATP-4 (grade-code 2026-06-22) — `classifyColumn` prefers the STRUCTURED
 * `column.terminalKind` over the locale-fragile name regex, so a cancellation
 * lane renamed to a non-English (or otherwise non-matching) label is still
 * excluded from schedule pressure (ADR 0103). Legacy boards with no
 * `terminalKind` fall back to the stable id / regex heuristic.
 */
import { describe, expect, it } from 'vitest';
import { classifyColumn } from '../src/features/priority-matrix/priorityMatrixService.js';
import type { KanbanBoard, KanbanColumn } from '../src/host/kanbanService.js';

function board(columns: KanbanColumn[]): KanbanBoard {
  return { id: 'b1', tenantId: 't1', name: 'B', columns, createdAt: '', updatedAt: '' };
}

describe('classifyColumn — structured terminalKind (CHATP-4)', () => {
  it('a RENAMED cancellation lane with terminalKind beats the name regex', () => {
    // id is no longer `wont-do` and the name "Abgebrochen" matches no English regex,
    // but the structured kind classifies it correctly.
    const b = board([
      { id: 'open', name: 'Offen' },
      { id: 'cancelled-de', name: 'Abgebrochen', terminal: true, terminalKind: 'cancellation' },
      { id: 'done-de', name: 'Erledigt', terminal: true, terminalKind: 'completion' },
    ]);
    const cancel = classifyColumn(b, 'cancelled-de');
    expect(cancel.isTerminal).toBe(true);
    expect(cancel.isCancelled).toBe(true); // would be FALSE under the old name regex

    const done = classifyColumn(b, 'done-de');
    expect(done.isTerminal).toBe(true);
    expect(done.isCancelled).toBe(false); // terminalKind:'completion' is NOT a cancellation
  });

  it('the default seeded lanes classify correctly via terminalKind', () => {
    const b = board([
      { id: 'new', name: 'New' },
      { id: 'wont-do', name: "Won't Do", terminal: true, terminalKind: 'cancellation' },
      { id: 'done', name: 'Done', terminal: true, terminalKind: 'completion' },
    ]);
    expect(classifyColumn(b, 'wont-do').isCancelled).toBe(true);
    expect(classifyColumn(b, 'done').isCancelled).toBe(false);
  });

  it('legacy board WITHOUT terminalKind falls back to the stable id + name regex', () => {
    const b = board([
      { id: 'open', name: 'Open' },
      { id: 'wont-do', name: 'Renamed', terminal: true }, // stable id still wins
      { id: 'abandoned', name: 'Abandoned', terminal: true }, // name regex catches "abandon"
      { id: 'done', name: 'Done', terminal: true },
    ]);
    expect(classifyColumn(b, 'wont-do').isCancelled).toBe(true);
    expect(classifyColumn(b, 'abandoned').isCancelled).toBe(true);
    expect(classifyColumn(b, 'done').isCancelled).toBe(false);
  });
});
