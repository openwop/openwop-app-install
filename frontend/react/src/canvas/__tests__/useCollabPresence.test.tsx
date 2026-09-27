/**
 * useCollabPresence tests (ADR 0359 Phase 4 / D5). Two Awareness instances on
 * two Y.Docs, states relayed via the y-protocols encode/apply pair — proving:
 * peer mirroring (self excluded), positional selection surfacing, and the
 * COALESCED join/leave announcement batch (the a11y budget: one polite
 * message per 2 s window, no initial-snapshot announcements, no selection
 * announcements).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { collabConnectionAnnouncement, collabGuestSuffix, presenceSelfName, useCollabPresence } from '../useCollabPresence.js';
import type { CollabState } from '../useCollab.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
beforeEach(() => { vi.useRealTimers(); });

/** Two awareness instances that mirror each other (bidirectional relay). */
function linkedAwareness(): { local: Awareness; remote: Awareness } {
  const dA = new Y.Doc(); const dB = new Y.Doc();
  const local = new Awareness(dA); const remote = new Awareness(dB);
  const relay = (from: Awareness, to: Awareness) => ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const changed = [...added, ...updated, ...removed];
    if (changed.length > 0) applyAwarenessUpdate(to, encodeAwarenessUpdate(from, changed), 'relay');
  };
  const lToR = relay(local, remote); const rToL = relay(remote, local);
  local.on('update', lToR); remote.on('update', rToL);
  cleanup.push(() => { local.destroy(); remote.destroy(); });
  return { local, remote };
}

function session(awareness: Awareness): CollabState {
  return {
    enabled: true, ydoc: awareness.doc, awareness, synced: true, connected: true,
    claimSeed: vi.fn().mockResolvedValue(false),
  };
}

describe('useCollabPresence', () => {
  it('mirrors peers (self excluded) with their selection + frame', async () => {
    const { local, remote } = linkedAwareness();
    const collab = session(local);
    const { result } = renderHook(() => useCollabPresence({
      collab, selfName: 'Me', sel: null, frame: null,
    }));
    act(() => {
      remote.setLocalStateField('user', { name: 'Ana' });
      remote.setLocalStateField('sel', { col: 'shapes', idx: 2 });
      remote.setLocalStateField('frame', 1);
    });
    await waitFor(() => expect(result.current.peers.length).toBe(1));
    expect(result.current.peers[0]).toMatchObject({ name: 'Ana', sel: { col: 'shapes', idx: 2 }, frame: 1 });
  });

  it('publishes own identity + throttled selection into awareness', async () => {
    const { local, remote } = linkedAwareness();
    const collab = session(local);
    renderHook(() => useCollabPresence({
      collab, selfName: 'Me', sel: { col: 'shapes', idx: 0 }, frame: 0,
    }));
    await waitFor(() => {
      const state = remote.getStates().get(local.clientID) as Record<string, unknown> | undefined;
      expect((state?.user as { name?: string } | undefined)?.name).toBe('Me');
      expect(state?.sel).toEqual({ col: 'shapes', idx: 0 });
    });
  });

  it('coalesces join/leave into ONE polite batch (no initial-snapshot announcement)', async () => {
    const { local, remote } = linkedAwareness();
    // A peer present BEFORE mount — context, never announced.
    remote.setLocalStateField('user', { name: 'Early' });
    const collab = session(local);
    const batches: { joined: string[]; left: string[] }[] = [];
    const { result } = renderHook(() => useCollabPresence({
      collab, selfName: 'Me', sel: null, frame: null,
      onPeersChanged: (b) => batches.push(b),
    }));
    await waitFor(() => expect(result.current.peers.length).toBe(1));
    expect(batches).toEqual([]); // initial snapshot silent
    // A rename/selection change is NOT a join — still silent.
    act(() => { remote.setLocalStateField('sel', { col: 'shapes', idx: 1 }); });
    await waitFor(() => expect(result.current.peers[0]?.sel).toEqual({ col: 'shapes', idx: 1 }));
    expect(batches).toEqual([]);
    // A real leave lands as one coalesced batch after the window.
    act(() => { remote.setLocalState(null); });
    await waitFor(() => expect(result.current.peers.length).toBe(0));
    await waitFor(() => expect(batches.length).toBe(1), { timeout: 4000 });
    expect(batches[0]).toEqual({ joined: [], left: ['Early'] });
  });
});

describe('collabGuestSuffix', () => {
  it('returns 4 chars, distinct across calls (distinct guest name => distinct hue)', () => {
    const seen = new Set(Array.from({ length: 64 }, () => collabGuestSuffix()));
    for (const s of seen) expect(s).toHaveLength(4);
    expect(seen.size).toBeGreaterThan(60);
  });

  it('falls back when crypto.randomUUID is unavailable (plain-http dev context)', () => {
    const orig = globalThis.crypto;
    vi.stubGlobal('crypto', {});
    try {
      const s = collabGuestSuffix();
      expect(s).toHaveLength(4);
      expect(s).toMatch(/^\d{4}$/);
    } finally {
      vi.stubGlobal('crypto', orig);
      vi.unstubAllGlobals();
    }
  });
});

describe('presenceSelfName — RTCC-4: never broadcast the user email as a presence name', () => {
  // The resolved name is published to Yjs awareness `user.name` and relayed
  // VERBATIM to every room peer (and, via SLC-1, to a same-tenant non-member of
  // a private-project room). A `|| authUser.email` fallback therefore leaks the
  // user's email to all co-editors — the PII-in-presence defect. The only
  // fallbacks allowed here are the real displayName or the non-PII guest label.
  const GUEST = 'Guest 4f2a';

  it('uses displayName when present', () => {
    expect(presenceSelfName({ displayName: 'Dana Ops', email: 'dana@example.co' }, GUEST)).toBe('Dana Ops');
  });

  it('falls back to the non-PII guest label when there is no displayName — NEVER the email', () => {
    const name = presenceSelfName({ email: 'dana@example.co' }, GUEST);
    expect(name).toBe(GUEST);
    expect(name).not.toContain('@');
    expect(name).not.toBe('dana@example.co');
  });

  it('treats a blank/whitespace displayName as absent (no email leak through the falsy gap)', () => {
    expect(presenceSelfName({ displayName: '   ', email: 'dana@example.co' }, GUEST)).toBe(GUEST);
    expect(presenceSelfName({ displayName: '', email: 'dana@example.co' }, GUEST)).toBe(GUEST);
  });

  it('falls back to the guest label for a null/undefined user', () => {
    expect(presenceSelfName(null, GUEST)).toBe(GUEST);
    expect(presenceSelfName(undefined, GUEST)).toBe(GUEST);
  });
});

describe('RTCC-4 — presence identity publishers route through presenceSelfName (class guard)', () => {
  // The email-in-presence leak is a CLASS: there are exactly TWO presence
  // identity publishers (canvas + workflow builder), each with its OWN
  // `awareness.setLocalStateField('user', {name})`. The pure resolver above is
  // tested; this guard pins that BOTH call sites feed it their `selfName` and
  // that neither reintroduces a raw `email` fallback on that line (the miss the
  // adversarial review caught: the builder site was the second, unfixed copy).
  const srcDir = join(process.cwd(), 'src'); // vitest runs from frontend/react
  const selfNameLine = (rel: string): string =>
    readFileSync(join(srcDir, rel), 'utf8').split('\n').find((l) => l.includes('selfName:')) ?? '';

  it('canvas CanvasEditorPage routes selfName via presenceSelfName, never the email', () => {
    const line = selfNameLine('canvas/CanvasEditorPage.tsx');
    expect(line).toContain('presenceSelfName(authUser');
    expect(line).not.toMatch(/email/);
  });

  it('builder BuilderShell routes selfName via presenceSelfName, never the email', () => {
    const line = selfNameLine('builder/BuilderShell.tsx');
    expect(line).toContain('presenceSelfName(authUser');
    expect(line).not.toMatch(/email/);
  });
});

/**
 * RTCU-1 — a collab connection drop was a VISUAL-only state change. The chip text
 * swapped Live -> Reconnecting and the dot greyed, but nothing reached a screen
 * reader, so a SR user kept editing with no signal that their edits had stopped
 * being shared. These legs pin the TRANSITION RULE; the wiring leg below pins that
 * the editor actually routes it to the live region (the two fail independently --
 * a correct rule nobody calls announces nothing).
 */
describe('collabConnectionAnnouncement — RTCU-1: only a real change speaks', () => {
  it('the FIRST observed value is silent, connected or not (it is the expected state on open)', () => {
    expect(collabConnectionAnnouncement(null, true)).toBeNull();
    expect(collabConnectionAnnouncement(null, false)).toBeNull();
  });

  it('a drop announces, and a recovery announces', () => {
    expect(collabConnectionAnnouncement(true, false)).toBe('dropped');
    expect(collabConnectionAnnouncement(false, true)).toBe('reconnected');
  });

  it('an unchanged value is silent in both directions (a re-render must not re-announce)', () => {
    expect(collabConnectionAnnouncement(true, true)).toBeNull();
    expect(collabConnectionAnnouncement(false, false)).toBeNull();
  });

  it('collab OFF (now === null) is silent from every prior state', () => {
    for (const was of [null, true, false] as const) {
      expect(collabConnectionAnnouncement(was, null), String(was)).toBeNull();
    }
  });
});

describe('RTCU-1 — the canvas editor routes the verdict to the polite live region (wiring)', () => {
  // The rule above is pure and would pass with nothing calling it. This reads the
  // call site, the same way the RTCC-4 class guard does, because a component-level
  // render of the rule proves the rule and not the page that must use it.
  const src = readFileSync(join(process.cwd(), 'src', 'canvas', 'CanvasEditorPage.tsx'), 'utf8');

  it('feeds the remembered previous value into the rule and announces BOTH outcomes', () => {
    expect(src).toContain('collabConnectionAnnouncement(prevConnectedRef.current, collabConnected)');
    expect(src).toContain("t('annCollabReconnected')");
    expect(src).toContain("t('annCollabDropped')");
  });

  it('announces POLITELY with collapseRepeats — a flapping socket must not back up the queue', () => {
    const line = src.split('\n').find((l) => l.includes('annCollabDropped')) ?? '';
    expect(line).toContain('setAnnounce(');
    expect(line).toContain('collapseRepeats: true');
    expect(line, 'a dropped socket is ambient, not an emergency interrupt').not.toContain('announceAssertive');
  });
});
