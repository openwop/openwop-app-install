/**
 * ADR 0368 P1 — the tour action registry (the chassis seam): semantic ids in,
 * live targets out; HITL contract shape; the coverage listing the conventions
 * test (P4) will pin shipped tours against.
 *
 * PROTECTED (ADR 0489 D1): `narrowCheckpointVerdict` is the FAIL-CLOSED gate — a
 * malformed checkpoint return must never read as "already satisfied". Each malformed
 * row asserts its exact failure detail (w51 r2; was "any truthy string").
 * Sabotage-witnessed (/grade-tests w51): dropping the undefined arm, the blank-reason
 * trim, the empty-string detail, or the unrecognized fallback reds its row; a lookup
 * returning undefined reds cases 1/3; a registration that drops or refuses to
 * replace an action reds case 2.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerWalkthroughAction,
  getWalkthroughAction,
  registerWalkthroughCheckpoint,
  getWalkthroughCheckpoint,
  narrowCheckpointVerdict,
  listWalkthroughActionIds,
  __resetWalkthroughRegistryForTests,
  type WalkthroughAction,
  type WalkthroughCheckpoint,
} from '../actionRegistry.js';

beforeEach(__resetWalkthroughRegistryForTests);

describe('tour action registry', () => {
  it('registers + resolves semantic actions; unknown ids are undefined (the player pauses honestly)', () => {
    const el = document.createElement('button');
    registerWalkthroughAction('demo.first.click', { route: '/demo', resolve: () => el, verb: 'click' });
    expect(getWalkthroughAction('demo.first.click')?.resolve()).toBe(el);
    expect(getWalkthroughAction('demo.missing')).toBeUndefined();
    expect(listWalkthroughActionIds()).toEqual(['demo.first.click']);
  });

  // Twin: useWalkthroughPlayer 'an HITL step waits for the user; the completion
  // subscription resolves with the value' drives hitlComplete END-TO-END. This case
  // owns what the player never exercises: the registry hands back the SAME action
  // object (every field — hitlComplete, perform, verb — survives storage), and a
  // re-registration of the id (a remounted feature) REPLACES the old action rather
  // than leaving a stale target behind.
  it('HITL actions expose the completion subscription — stored by identity, replaced on re-registration', () => {
    const hook: { fire: ((v: unknown) => void) | null } = { fire: null };
    const first: WalkthroughAction = {
      route: '/demo',
      resolve: () => document.createElement('input'),
      verb: 'click',
      hitlComplete: (_el, done) => { hook.fire = done; return () => { hook.fire = null; }; },
    };
    registerWalkthroughAction('demo.upload.file', first);
    expect(getWalkthroughAction('demo.upload.file')).toBe(first);
    const seen: unknown[] = [];
    const off = getWalkthroughAction('demo.upload.file')!.hitlComplete!(document.createElement('input'), (v) => seen.push(v));
    hook.fire?.({ mediaRef: 'media:abc' });
    expect(seen).toEqual([{ mediaRef: 'media:abc' }]);
    off?.();
    expect(hook.fire).toBeNull();

    const replacement: WalkthroughAction = { route: '/demo/v2', resolve: () => null, verb: 'focus' };
    registerWalkthroughAction('demo.upload.file', replacement);
    expect(getWalkthroughAction('demo.upload.file')).toBe(replacement);
    expect(listWalkthroughActionIds()).toEqual(['demo.upload.file']);
  });

  it('checkpoints are stored and looked up by id; unknown ids are undefined', async () => {
    const pass: WalkthroughCheckpoint = { evaluate: () => null };
    const fail: WalkthroughCheckpoint = { evaluate: () => 'no brief found' };
    registerWalkthroughCheckpoint('demo.brief-exists', pass);
    registerWalkthroughCheckpoint('demo.always-fails', fail);
    expect(getWalkthroughCheckpoint('demo.brief-exists')).toBe(pass);
    expect(getWalkthroughCheckpoint('demo.always-fails')).toBe(fail);
    expect(getWalkthroughCheckpoint('demo.missing')).toBeUndefined();
    expect(await getWalkthroughCheckpoint('demo.always-fails')!.evaluate()).toBe('no brief found');
  });

  // ── ADR 0489 D1 — narrowCheckpointVerdict is the FAIL-CLOSED gate ────────
  describe('narrowCheckpointVerdict', () => {
    it('passes the legacy arms through verbatim', () => {
      expect(narrowCheckpointVerdict(null)).toBeNull();
      expect(narrowCheckpointVerdict(undefined)).toBeNull(); // a void checkpoint = pass
      expect(narrowCheckpointVerdict('no brief found')).toBe('no brief found');
    });

    it('accepts a well-formed already-satisfied verdict', () => {
      expect(narrowCheckpointVerdict({ satisfied: true, because: 'Already connected.' }))
        .toEqual({ satisfied: true, because: 'Already connected.' });
    });

    const NO_REASON = 'checkpoint reported already-satisfied without a reason';
    const UNRECOGNIZED = 'checkpoint returned an unrecognized verdict';
    it.each([
      ['satisfied without a reason', { satisfied: true }, NO_REASON],
      ['satisfied with a blank reason', { satisfied: true, because: '   ' }, NO_REASON],
      ['satisfied with a non-string reason', { satisfied: true, because: 42 }, NO_REASON],
      ['a bare truthy object', { ok: true }, UNRECOGNIZED],
      ['satisfied:false', { satisfied: false, because: 'nope' }, UNRECOGNIZED],
      ['an array', ['satisfied'], UNRECOGNIZED],
      ['a number', 7, UNRECOGNIZED],
      ['a boolean', true, UNRECOGNIZED],
      ['an empty failure string', '', 'checkpoint returned an empty failure detail'],
    ])('FAILS CLOSED on %s — never silently skips', (_label, input, detail) => {
      // A FAILURE (a string detail), never a skip — and the detail names why.
      expect(narrowCheckpointVerdict(input)).toBe(detail);
    });
  });
});
