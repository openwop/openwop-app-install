/**
 * useCollabDoc facade tests (ADR 0359 Phase 3). No provider needed — the
 * facade only consumes the CollabState shape, so a real Y.Doc + a stub
 * claimSeed exercise the full lifecycle: seed-on-win, live flip, local
 * set/replace committing into Y, remote updates landing doc + remap, teardown.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createRef } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { useCollabDoc } from '../useCollabDoc.js';
import type { CollabState } from '../useCollab.js';
import type { CollabDocShape } from '../collabDocBinding.js';

type Dict = Record<string, unknown>;
interface DrawDoc extends Dict { title: string; shapes: Dict[] }
const SHAPE: CollabDocShape = { collections: [{ key: 'shapes' }] };
const coerce = (s: Dict): DrawDoc => ({ title: typeof s.title === 'string' ? s.title : '', shapes: Array.isArray(s.shapes) ? (s.shapes as Dict[]) : [] });

// Awareness runs a renewal interval — destroy after each test or the fork
// never exits (the vitest worker-timeout fingerprint).
const awarenesses: Awareness[] = [];
afterEach(() => { for (const a of awarenesses.splice(0)) a.destroy(); });

function session(ydoc: Y.Doc, seedWins: boolean): CollabState {
  const awareness = new Awareness(ydoc);
  awarenesses.push(awareness);
  return {
    enabled: true, ydoc, synced: true, awareness,
    claimSeed: vi.fn().mockResolvedValue(seedWins),
  };
}

describe('useCollabDoc', () => {
  it('inactive ⇒ not live, no doc', () => {
    const initialDocRef = createRef<DrawDoc | null>(); // stable across renders
    const { result } = renderHook(() => useCollabDoc<DrawDoc>({
      active: false, collab: { enabled: false }, shape: SHAPE,
      initialDocRef, coerce, onRemote: () => {},
    }));
    expect(result.current.live).toBe(false);
    expect(result.current.doc).toBeNull();
  });

  it('seed-winner writes the loaded copy; local set commits into Y; remote update lands doc + remap', async () => {
    const ydoc = new Y.Doc();
    const initialDocRef = { current: { title: 'T', shapes: [{ label: 's0' }] } as DrawDoc | null };
    const remaps: unknown[] = [];
    // Stable across renders (the real chassis passes the stable useCollab state).
    const collab = session(ydoc, true);
    const { result, unmount } = renderHook(() => useCollabDoc<DrawDoc>({
      active: true, collab, shape: SHAPE,
      initialDocRef, coerce, onRemote: (r) => remaps.push(r),
    }));
    await waitFor(() => expect(result.current.live).toBe(true));
    expect(result.current.doc?.title).toBe('T');
    // Local gesture reaches the shared Y.Doc.
    act(() => result.current.set({ title: 'T', shapes: [{ label: 's0' }, { label: 's1' }] }));
    const root = ydoc.getMap<unknown>('doc');
    expect((root.get('shapes') as Y.Array<unknown>).length).toBe(2);
    // A remote update (another doc's change applied) lands doc + remap.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const parr = peer.getMap<unknown>('doc').get('shapes') as Y.Array<unknown>;
    const nm = new Y.Map<unknown>(); nm.set('label', 'remote');
    parr.insert(0, [nm]);
    act(() => { Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(ydoc)), 'remote'); });
    await waitFor(() => expect(result.current.doc?.shapes.length).toBe(3));
    expect(result.current.doc?.shapes[0]?.label).toBe('remote');
    expect(remaps.length).toBeGreaterThan(0);
    act(() => unmount());
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
  });
});
