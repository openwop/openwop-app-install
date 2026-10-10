/**
 * Canonical column → lane classification (BLD-8). Previously duplicated in
 * `KanbanBoardView.laneKindOf` and `agents/agentViewModel.laneOf`; a single
 * source so a new lane convention is added once, not in two places that can
 * drift. Matches a column to a lane by its canonical id OR its (case-
 * insensitive) display name, supporting both id- and label-keyed boards.
 *
 * ADR 0774 D1 — the backend has a byte-for-byte twin (`columnLaneKind` in
 * `host/kanbanService.ts`) that decides which lane the agent's pick moves a
 * card into; both sides pin the same case table in a test. Change them
 * together, or the board and the work loop will disagree about "in progress".
 */

export type LaneKind = 'todo' | 'working' | 'waiting' | 'done';

export function columnLaneKind(col: { id: string; name: string }): LaneKind | null {
  const id = col.id.toLowerCase();
  const name = col.name.toLowerCase();
  if (id === 'todo' || name === 'to do') return 'todo';
  if (id === 'working' || id === 'doing' || id === 'in-progress' || name === 'working' || name === 'doing' || name === 'in progress') return 'working';
  if (id === 'waiting' || name.startsWith('waiting')) return 'waiting';
  if (id === 'done' || name === 'done') return 'done';
  return null;
}
