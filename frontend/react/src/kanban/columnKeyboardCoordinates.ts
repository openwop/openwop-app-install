/**
 * Keyboard coordinate getter for the board (CRM-UX-18 — shared primitive, so
 * `/boards` and the CRM deals board both get it).
 *
 * dnd-kit's `defaultKeyboardCoordinateGetter` moves the dragged card 25 px per
 * arrow press. The board's own instructions (`dndInstructions`) promise "use
 * the arrow keys to move between COLUMNS", and a `.kb-col` is 280 px wide — so
 * a screen-reader user was told one thing and handed ~12 presses per stage,
 * each announced as "over <the same column>". This getter makes Left / Right
 * mean what the instructions say: one press, one column, snapped to the
 * neighbouring droppable's rect. Individual cards are also droppables now, so
 * Up / Down keep dnd-kit's closest target behavior and can select an in-column
 * placement anchor; this helper intentionally owns only cross-column snapping.
 *
 * `sortableKeyboardCoordinates` (dnd-kit/sortable) is not the tool here: it
 * walks SORTABLE items, and these columns are plain droppables.
 */
import {
  KeyboardCode,
  defaultKeyboardCoordinateGetter,
  type ClientRect,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';

interface ColumnRect { id: UniqueIdentifier; rect: ClientRect }

export const columnSnapCoordinateGetter: KeyboardCoordinateGetter = (event, args) => {
  const { context, currentCoordinates } = args;
  if (event.code !== KeyboardCode.Right && event.code !== KeyboardCode.Left) {
    return defaultKeyboardCoordinateGetter(event, args);
  }
  const { droppableContainers, droppableRects, collisionRect, over } = context;
  const columns: ColumnRect[] = droppableContainers.getEnabled()
    // Dnd-kit containers always carry `data`, but keeping this boundary
    // defensive preserves the shared pure getter's test/embed contract.
    .filter((container) => container.data?.current?.kind !== 'card')
    .flatMap((c) => { const rect = droppableRects.get(c.id); return rect ? [{ id: c.id, rect }] : []; })
    .sort((a, b) => a.rect.left - b.rect.left);
  if (columns.length === 0) return defaultKeyboardCoordinateGetter(event, args);

  // Which column holds the card NOW: the one dnd-kit reports it is over, else
  // the one whose rect spans the card's centre, else the nearest by centre.
  const cx = collisionRect ? collisionRect.left + collisionRect.width / 2 : currentCoordinates.x;
  let idx = over ? columns.findIndex((c) => c.id === over.id) : -1;
  if (idx < 0) idx = columns.findIndex((c) => cx >= c.rect.left && cx <= c.rect.left + c.rect.width);
  if (idx < 0) {
    let bestDistance = Number.POSITIVE_INFINITY;
    columns.forEach((c, i) => {
      const d = Math.abs(c.rect.left + c.rect.width / 2 - cx);
      if (d < bestDistance) { bestDistance = d; idx = i; }
    });
  }

  const target = columns[idx + (event.code === KeyboardCode.Right ? 1 : -1)];
  // At the edge: no move. Returning nothing leaves the card where it is (and
  // says nothing new — the live region already named this column).
  if (!target) return undefined;

  // Land the card centred in the target column, at the same height it was,
  // clamped so its rect still intersects the column (collision detection is
  // rect-intersection: a card below a short column would be "over" nothing).
  const width = collisionRect?.width ?? 0;
  const height = collisionRect?.height ?? 0;
  const x = target.rect.left + Math.max(0, (target.rect.width - width) / 2);
  const maxY = target.rect.top + Math.max(0, target.rect.height - height);
  const y = Math.min(Math.max(currentCoordinates.y, target.rect.top), maxY);
  return { x, y };
};
