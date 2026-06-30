/**
 * Canonical column → lane classification (BLD-8). Previously duplicated in
 * `KanbanBoardView.laneKindOf` and `agents/agentViewModel.laneOf`; a single
 * source so a new lane convention is added once, not in two places that can
 * drift. Matches a column to a lane by its canonical id OR its (case-
 * insensitive) display name, supporting both id- and label-keyed boards.
 */

export type LaneKind = 'todo' | 'working' | 'waiting' | 'done';

export function columnLaneKind(col: { id: string; name: string }): LaneKind | null {
  const id = col.id.toLowerCase();
  const name = col.name.toLowerCase();
  if (id === 'todo' || name === 'to do') return 'todo';
  if (id === 'working' || id === 'doing' || name === 'working' || name === 'doing') return 'working';
  if (id === 'waiting' || name.startsWith('waiting')) return 'waiting';
  if (id === 'done' || name === 'done') return 'done';
  return null;
}
