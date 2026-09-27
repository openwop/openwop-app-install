/**
 * CRM-UX-18 — the board's keyboard sensor snaps Left/Right to the neighbouring
 * COLUMN (what `dndInstructions` promises), not dnd-kit's 25 px default.
 * Pure-function coverage of the getter with a hand-built sensor context; the
 * end-to-end press sequence lives in the CRM deals-board test.
 */
import { describe, it, expect } from 'vitest';
import type { ClientRect, UniqueIdentifier } from '@dnd-kit/core';
import { columnSnapCoordinateGetter } from '../columnKeyboardCoordinates.js';

const rect = (left: number, top: number, width: number, height: number): ClientRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

/** Three 280 px columns at x = 0 / 300 / 600 — the `.kb-col` geometry. */
const columns: Array<[UniqueIdentifier, ClientRect]> = [
  ['s1', rect(0, 0, 280, 600)],
  ['s2', rect(300, 0, 280, 600)],
  ['s3', rect(600, 0, 280, 300)], // a short column
];

function context(overId: UniqueIdentifier | null, collisionRect: ClientRect) {
  const droppableRects = new Map(columns);
  const droppableContainers = {
    getEnabled: () => columns.map(([id]) => ({ id, disabled: false })),
  };
  return {
    context: {
      over: overId === null ? null : { id: overId },
      collisionRect,
      droppableRects,
      droppableContainers,
    },
    currentCoordinates: { x: collisionRect.left, y: collisionRect.top },
    active: 'card',
  } as unknown as Parameters<typeof columnSnapCoordinateGetter>[1];
}

const key = (code: string) => ({ code } as KeyboardEvent);

describe('columnSnapCoordinateGetter', () => {
  it('ArrowRight from column 1 lands INSIDE column 2 in one press (not +25 px)', () => {
    const card = rect(10, 40, 260, 80);
    const out = columnSnapCoordinateGetter(key('ArrowRight'), context('s1', card));
    expect(out).toBeTruthy();
    // Inside s2's rect, centred: 300 + (280 - 260) / 2 = 310.
    expect(out!.x).toBe(310);
    expect(out!.x).toBeGreaterThanOrEqual(300);
    expect(out!.x + card.width).toBeLessThanOrEqual(580);
    expect(out!.y).toBe(40);
  });

  it('ArrowLeft from column 2 lands inside column 1', () => {
    const card = rect(310, 40, 260, 80);
    const out = columnSnapCoordinateGetter(key('ArrowLeft'), context('s2', card));
    expect(out!.x).toBe(10);
  });

  it('at the first column, ArrowLeft returns nothing — the card stays put', () => {
    expect(columnSnapCoordinateGetter(key('ArrowLeft'), context('s1', rect(10, 40, 260, 80)))).toBeUndefined();
  });

  it('at the last column, ArrowRight returns nothing', () => {
    expect(columnSnapCoordinateGetter(key('ArrowRight'), context('s3', rect(610, 40, 260, 80)))).toBeUndefined();
  });

  it('clamps y so the card still intersects a SHORT target column', () => {
    // Card sits at y=500 in the tall column 2; column 3 is only 300 tall.
    const out = columnSnapCoordinateGetter(key('ArrowRight'), context('s2', rect(310, 500, 260, 80)));
    expect(out!.y).toBe(300 - 80);
  });

  it('with no `over` it locates the column from the card\'s centre', () => {
    const out = columnSnapCoordinateGetter(key('ArrowRight'), context(null, rect(310, 40, 260, 80)));
    expect(out!.x).toBe(610);
  });

  it('ArrowDown keeps dnd-kit\'s default 25 px step (no in-column ordering to snap to)', () => {
    const out = columnSnapCoordinateGetter(key('ArrowDown'), context('s1', rect(10, 40, 260, 80)));
    expect(out).toEqual({ x: 10, y: 65 });
  });
});
