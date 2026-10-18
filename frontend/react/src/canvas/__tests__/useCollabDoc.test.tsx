/**
 * useCollabDoc facade tests (ADR 0359 Phase 3). No provider needed — the
 * facade only consumes the CollabState shape, so a real Y.Doc + a stub
 * claimSeed exercise the full lifecycle: seed-on-win, live flip, local
 * set/replace committing into Y, remote updates landing doc + remap, teardown.
 *
 * Breaks it: a facade that binds when the definition is not an elements type
 * (a live session alone must not activate it), a seed-loser clobbering the
 * room with its stale copy, local gestures that never reach the shared doc,
 * remote edits that never reach React (or arrive without the selection remap),
 * and a binding that keeps listening after unmount.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createRef } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { useCollabDoc } from '../useCollabDoc.js';
import type { CollabSession } from '../useCollab.js';
import type { CollabDocShape, CollabIndexRemap } from '../collabDocBinding.js';

type Dict = Record<string, unknown>;
interface DrawDoc extends Dict { title: string; shapes: Dict[] }
const SHAPE: CollabDocShape = { collections: [{ key: 'shapes' }] };
const coerce = (s: Dict): DrawDoc => ({ title: typeof s.title === 'string' ? s.title : '', shapes: Array.isArray(s.shapes) ? (s.shapes as Dict[]) : [] });

// Awareness runs a renewal interval — destroy after each test or the fork
// never exits (the vitest worker-timeout fingerprint).
const awarenesses: Awareness[] = [];
afterEach(() => { for (const a of awarenesses.splice(0)) a.destroy(); });

function session(ydoc: Y.Doc, seedWins: boolean): CollabSession {
  const awareness = new Awareness(ydoc);
  awarenesses.push(awareness);
  return {
    enabled: true, ydoc, synced: true, connected: true, failed: false, awareness,
    claimSeed: vi.fn(async () => seedWins),
  };
}

/** Let the binding's dynamic import + the seed election resolve. */
async function settle(): Promise<void> {
  await act(async () => {
    await import('../collabDocBinding.js');
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

/** Insert `label` at the head of `ydoc`'s shapes from a separate peer doc. */
function remoteInsertHead(ydoc: Y.Doc, label: string): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  const parr = peer.getMap<unknown>('doc').get('shapes') as Y.Array<unknown>;
  const nm = new Y.Map<unknown>(); nm.set('label', label);
  parr.insert(0, [nm]);
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(ydoc)), 'remote');
}

describe('useCollabDoc', () => {
  it('inactive ⇒ not live, no doc — even when the collab session itself is live and synced', async () => {
    const initialDocRef = createRef<DrawDoc | null>(); // stable across renders
    const collab = session(new Y.Doc(), true);
    const { result } = renderHook(() => useCollabDoc<DrawDoc>({
      active: false, collab, shape: SHAPE,
      initialDocRef, coerce, onRemote: () => {},
    }));
    await settle();
    expect(result.current.live).toBe(false);
    expect(result.current.doc).toBeNull();
    expect(collab.claimSeed).not.toHaveBeenCalled(); // never even ran the election
  });

  it('seed-winner writes the loaded copy; local set/replace commit into Y; remote update lands doc + remap; unmount stops listening', async () => {
    const ydoc = new Y.Doc();
    const initialDocRef = { current: { title: 'T', shapes: [{ label: 's0' }] } as DrawDoc | null };
    const remaps: CollabIndexRemap[] = [];
    // Stable across renders (the real chassis passes the stable useCollab state).
    const collab = session(ydoc, true);
    const { result, unmount } = renderHook(() => useCollabDoc<DrawDoc>({
      active: true, collab, shape: SHAPE,
      initialDocRef, coerce, onRemote: (r) => remaps.push(r),
    }));
    await waitFor(() => expect(result.current.live).toBe(true));
    expect(result.current.doc?.title).toBe('T');
    const root = ydoc.getMap<unknown>('doc');
    const yLabels = (): unknown[] => (root.get('shapes') as Y.Array<Y.Map<unknown>>).toArray().map((m) => m.get('label'));
    expect(yLabels()).toEqual(['s0']);
    // Local gesture (set = a new undo step) reaches the shared Y.Doc.
    act(() => result.current.set({ title: 'T', shapes: [{ label: 's0' }, { label: 's1' }] }));
    expect(yLabels()).toEqual(['s0', 's1']);
    // Drag-move style replace reaches it too.
    act(() => result.current.replace({ title: 'T', shapes: [{ label: 's0' }, { label: 's1' }, { label: 's2' }] }));
    expect(yLabels()).toEqual(['s0', 's1', 's2']);
    // A remote update (another doc's change applied) lands doc + remap.
    act(() => { remoteInsertHead(ydoc, 'remote'); });
    await waitFor(() => expect(result.current.doc?.shapes.length).toBe(4));
    expect(result.current.doc?.shapes[0]?.label).toBe('remote');
    // The remap shifts a selection below the remote head insert by one.
    expect(remaps.at(-1)?.('shapes', 0)).toBe(1);
    // Teardown: after unmount a further remote edit reaches nobody.
    act(() => unmount());
    const seen = remaps.length;
    act(() => { remoteInsertHead(ydoc, 'after-unmount'); });
    await settle();
    expect(remaps.length).toBe(seen);
  });

  it('seed-loser does not write; it materializes what the room already holds', async () => {
    const ydoc = new Y.Doc();
    const root = ydoc.getMap<unknown>('doc');
    root.set('title', 'existing');
    const initialDocRef = { current: { title: 'LOCAL-STALE', shapes: [] } as DrawDoc | null };
    const collab = session(ydoc, false);
    const { result } = renderHook(() => useCollabDoc<DrawDoc>({
      active: true, collab, shape: SHAPE,
      initialDocRef, coerce, onRemote: () => {},
    }));
    await waitFor(() => expect(result.current.live).toBe(true));
    expect(result.current.doc?.title).toBe('existing'); // never clobbered by the loser
    expect(root.get('title')).toBe('existing');
  });
});
