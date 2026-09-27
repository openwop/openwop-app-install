/**
 * ADR 0368 P1 — the tour action registry (the chassis seam): semantic ids in,
 * live targets out; HITL contract shape; the coverage listing the conventions
 * test (P4) will pin shipped tours against.
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

  it('HITL actions expose the completion subscription (resolve-by-user, never scripted)', () => {
    let fire: ((v: unknown) => void) | null = null;
    registerWalkthroughAction('demo.upload.file', {
      route: '/demo',
      resolve: () => document.createElement('input'),
      verb: 'click',
      hitlComplete: (_el, done) => { fire = done; return () => { fire = null; }; },
    });
    const action = getWalkthroughAction('demo.upload.file')!;
    const seen: unknown[] = [];
    const off = action.hitlComplete!(document.createElement('input'), (v) => seen.push(v));
    fire!({ mediaRef: 'media:abc' });
    expect(seen).toEqual([{ mediaRef: 'media:abc' }]);
    off();
    expect(fire).toBeNull();
  });

  it('checkpoints evaluate to null (pass) or a failure detail', async () => {
    registerWalkthroughCheckpoint('demo.brief-exists', { evaluate: () => null });
    registerWalkthroughCheckpoint('demo.always-fails', { evaluate: () => 'no brief found' });
    expect(await getWalkthroughCheckpoint('demo.brief-exists')!.evaluate()).toBeNull();
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

    it.each([
      ['satisfied without a reason', { satisfied: true }],
      ['satisfied with a blank reason', { satisfied: true, because: '   ' }],
      ['satisfied with a non-string reason', { satisfied: true, because: 42 }],
      ['a bare truthy object', { ok: true }],
      ['satisfied:false', { satisfied: false, because: 'nope' }],
      ['an array', ['satisfied']],
      ['a number', 7],
      ['a boolean', true],
      ['an empty failure string', ''],
    ])('FAILS CLOSED on %s — never silently skips', (_label, input) => {
      const verdict = narrowCheckpointVerdict(input);
      expect(typeof verdict).toBe('string');   // i.e. a FAILURE, not a skip
      expect(verdict).toBeTruthy();            // and it carries a detail
    });
  });
});
