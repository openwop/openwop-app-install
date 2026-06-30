/**
 * BLD-1 — canonical column→lane classification (`columnLaneKind`, the single source
 * shared by KanbanBoardView + agentViewModel, BLD-8). Matches by canonical id OR
 * (case-insensitive) display name, so both id-keyed and label-keyed boards resolve.
 */
import { describe, it, expect } from 'vitest';
import { columnLaneKind } from '../laneKind.js';

describe('columnLaneKind', () => {
  it('matches each lane by its canonical id', () => {
    expect(columnLaneKind({ id: 'todo', name: 'whatever' })).toBe('todo');
    expect(columnLaneKind({ id: 'working', name: 'whatever' })).toBe('working');
    expect(columnLaneKind({ id: 'doing', name: 'whatever' })).toBe('working'); // `doing` is a working alias
    expect(columnLaneKind({ id: 'waiting', name: 'whatever' })).toBe('waiting');
    expect(columnLaneKind({ id: 'done', name: 'whatever' })).toBe('done');
  });

  it('falls back to the display name when the id is non-canonical', () => {
    expect(columnLaneKind({ id: 'col-1', name: 'To Do' })).toBe('todo');
    expect(columnLaneKind({ id: 'col-2', name: 'Working' })).toBe('working');
    expect(columnLaneKind({ id: 'col-3', name: 'Doing' })).toBe('working');
    expect(columnLaneKind({ id: 'col-4', name: 'Done' })).toBe('done');
  });

  it('is case-insensitive on both id and name', () => {
    expect(columnLaneKind({ id: 'TODO', name: 'X' })).toBe('todo');
    expect(columnLaneKind({ id: 'X', name: 'wOrKiNg' })).toBe('working');
    expect(columnLaneKind({ id: 'X', name: 'DONE' })).toBe('done');
  });

  it('matches any "waiting…" name by prefix (e.g. "Waiting on you")', () => {
    expect(columnLaneKind({ id: 'X', name: 'Waiting on approval' })).toBe('waiting');
    expect(columnLaneKind({ id: 'X', name: 'waiting for review' })).toBe('waiting');
  });

  it('returns null for an unrecognized column (no silent mis-bucketing)', () => {
    expect(columnLaneKind({ id: 'backlog', name: 'Backlog' })).toBeNull();
    expect(columnLaneKind({ id: '', name: '' })).toBeNull();
    // "to do" must be exact-name (a stray "todo list" name shouldn't match the `to do` rule)
    expect(columnLaneKind({ id: 'x', name: 'todo list' })).toBeNull();
  });
});
