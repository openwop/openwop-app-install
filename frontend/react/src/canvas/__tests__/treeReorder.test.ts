/**
 * ADR 0458 a11y — pins the sibling-reorder INDEX MATH that
 * `CanvasEditorPage.onOutlineReorder` relies on. `treeOps.moveNode` uses
 * insert-before semantics with a same-parent decrement (`treeOps.ts:146`), so a
 * one-step keyboard reorder is: UP → moveNode(from, sameParent, idx-1);
 * DOWN → moveNode(from, sameParent, idx+2). If moveNode's semantics ever change,
 * this test fails loudly rather than the a11y reorder silently mis-moving.
 */
import { describe, it, expect } from 'vitest';
import { treeOps } from '../treeOps.js';
import type { TreeNodeBase } from '../treeOps.js';

interface N extends TreeNodeBase { type: string; children?: N[] }
interface C { components: N[] }

const ops = treeOps<N, C>();
const frame = (components: N[]): C => JSON.parse(JSON.stringify({ components })) as C;
const types = (list: N[] | undefined): string[] => (list ?? []).map((n) => n.type);

describe('treeOps.moveNode — sibling reorder index math', () => {
  it('DOWN one = moveNode(from, sameParent, idx+2)', () => {
    const f = frame([{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
    const landed = ops.moveNode(f, [1], null, 1 + 2); // move b down one
    expect(types(f.components)).toEqual(['a', 'c', 'b']);
    expect(landed).toEqual([2]);
  });

  it('UP one = moveNode(from, sameParent, idx-1)', () => {
    const f = frame([{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
    const landed = ops.moveNode(f, [2], null, 2 - 1); // move c up one
    expect(types(f.components)).toEqual(['a', 'c', 'b']);
    expect(landed).toEqual([1]);
  });

  it('nested: reorders WITHIN the parent only (no reparent)', () => {
    const f = frame([{ type: 'p', children: [{ type: 'x' }, { type: 'y' }] }]);
    const landed = ops.moveNode(f, [0, 0], [0], 0 + 2); // move x down within p
    expect(types(f.components[0]!.children)).toEqual(['y', 'x']);
    expect(landed).toEqual([0, 1]);
    expect(f.components).toHaveLength(1); // parent count unchanged — sibling-only
  });

  it('DOWN past the last index clamps to a no-op (the handler also guards this)', () => {
    const f = frame([{ type: 'a' }, { type: 'b' }]);
    ops.moveNode(f, [1], null, 1 + 2); // b is last; +2 clamps → stays last
    expect(types(f.components)).toEqual(['a', 'b']);
  });
});
