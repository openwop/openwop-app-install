/**
 * CRM-UX-18 — the board's keyboard sensor snaps Left/Right to the neighbouring
 * COLUMN (what `dndInstructions` promises), not dnd-kit's 25 px default.
 * Pure-function coverage of the getter with a hand-built, fully typed sensor
 * context (columns AND card droppables, as the board registers them); the
 * end-to-end press sequence lives in the CRM deals-board test.
 */
import { describe, it, expect } from 'vitest';
import type { ClientRect, DroppableContainer, SensorContext, UniqueIdentifier } from '@dnd-kit/core';
import { columnSnapCoordinateGetter } from '../columnKeyboardCoordinates.js';

const rect = (left: number, top: number, width: number, height: number): ClientRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

/** Three 280 px columns at x = 0 / 300 / 600 — the `.kb-col` geometry. */
const columns: Array<[UniqueIdentifier, ClientRect]> = [
  ['s1', rect(0, 0, 280, 600)],
  ['s2', rect(300, 0, 280, 600)],
  ['s3', rect(600, 0, 280, 300)], // a short column
];
/** Production shape: every CARD is a droppable too (`kanban-card-target:<id>`,
 *  `data.kind:'card'`), registered beside the columns. The getter must skip it —
 *  this one sits inside s1, so counting it as a "column" would make it the
 *  ArrowRight target from s1. */
const CARD_DROPPABLE: [UniqueIdentifier, ClientRect] = ['kanban-card-target:c1', rect(10, 40, 260, 80)];

const container = (id: UniqueIdentifier, kind: 'column' | 'card', r: ClientRect): DroppableContainer => ({
  id, key: id, disabled: false,
  data: { current: { kind } },
  node: { current: null },
  rect: { current: r },
});

/** A typed stand-in for dnd-kit's (unexported) `DroppableContainersMap`. */
class Containers extends Map<UniqueIdentifier, DroppableContainer> {
  override get(id: UniqueIdentifier | null | undefined): DroppableContainer | undefined {
    return id === null || id === undefined ? undefined : super.get(id);
  }
  toArray(): DroppableContainer[] { return [...this.values()]; }
  getEnabled(): DroppableContainer[] { return this.toArray().filter((c) => !c.disabled); }
  getNodeFor(): HTMLElement | undefined { return undefined; }
}

function context(overId: UniqueIdentifier | null, collisionRect: ClientRect): Parameters<typeof columnSnapCoordinateGetter>[1] {
  const all: Array<[UniqueIdentifier, ClientRect, 'column' | 'card']> = [
    ...columns.map(([id, r]): [UniqueIdentifier, ClientRect, 'column'] => [id, r, 'column']),
    [CARD_DROPPABLE[0], CARD_DROPPABLE[1], 'card'],
  ];
  const droppableContainers = new Containers(all.map(([id, r, kind]) => [id, container(id, kind, r)]));
  const overRect = overId === null ? undefined : columns.find(([id]) => id === overId)?.[1];
  const ctx: SensorContext = {
    activatorEvent: null,
    active: null,
    activeNode: null,
    collisionRect,
    collisions: null,
    draggableNodes: new Map(),
    draggingNode: null,
    draggingNodeRect: null,
    droppableRects: new Map(all.map(([id, r]) => [id, r])),
    droppableContainers,
    over: overId === null || !overRect ? null : { id: overId, rect: overRect, disabled: false, data: { current: { kind: 'column' } } },
    scrollableAncestors: [],
    scrollAdjustedTranslate: null,
  };
  return { context: ctx, currentCoordinates: { x: collisionRect.left, y: collisionRect.top }, active: 'card' };
}

const key = (code: string): KeyboardEvent => new KeyboardEvent('keydown', { code });

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
