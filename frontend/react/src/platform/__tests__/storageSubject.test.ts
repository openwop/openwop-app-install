/**
 * Storage-subject tri-state + observability (ADR 0434 / IDN-3, IDN-4).
 *
 * IDN-3: the boot window is DISTINGUISHABLE from settled-anonymous. Before this,
 * a read during boot returned `null` — indistinguishable from a real anonymous
 * session — so a returning signed-in user briefly read the anonymous key.
 * IDN-4: the module singleton is resettable so parallel suites don't bleed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetStorageSubjectForTest,
  PENDING_SUBJECT,
  getStorageSubject,
  isStorageSubjectResolved,
  setStorageSubject,
  storageSubjectSnapshot,
  subscribeStorageSubject,
} from '../storage.js';
import { adoptLocalContentForSubject } from '../../auth/localContentAdoption.js';

beforeEach(() => { __resetStorageSubjectForTest(); });
afterEach(() => { __resetStorageSubjectForTest(); });

describe('boot window vs settled-anonymous', () => {
  it('starts UNRESOLVED — the snapshot is the pending sentinel, not null', () => {
    expect(isStorageSubjectResolved()).toBe(false);
    expect(storageSubjectSnapshot()).toBe(PENDING_SUBJECT);
    // getStorageSubject stays null-safe: a pending read uses the anonymous key,
    // which can never expose another user's content.
    expect(getStorageSubject()).toBeNull();
  });

  it('settling to anonymous is DIFFERENT from pending', () => {
    setStorageSubject(null);
    expect(isStorageSubjectResolved()).toBe(true);
    expect(storageSubjectSnapshot()).toBeNull(); // anonymous, not the sentinel
  });

  it('settling to a user exposes the subject', () => {
    setStorageSubject('user-1');
    expect(storageSubjectSnapshot()).toBe('user-1');
    expect(getStorageSubject()).toBe('user-1');
  });
});

describe('observability (useSyncExternalStore contract)', () => {
  it('notifies subscribers on the pending→resolved transition', () => {
    const fn = vi.fn();
    const unsub = subscribeStorageSubject(fn);
    setStorageSubject(null); // resolve to anonymous
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('notifies on a subject CHANGE but not on a no-op re-set', () => {
    setStorageSubject('user-1');
    const fn = vi.fn();
    const unsub = subscribeStorageSubject(fn);
    setStorageSubject('user-1'); // same, already resolved → no fire
    expect(fn).not.toHaveBeenCalled();
    setStorageSubject('user-2'); // change → fire
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('stops notifying after unsubscribe', () => {
    const fn = vi.fn();
    subscribeStorageSubject(fn)(); // subscribe then immediately unsubscribe
    setStorageSubject('user-9');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('IDN-4 — the reset helper isolates suites', () => {
  it('clears subject, resolved flag, and listeners', () => {
    const fn = vi.fn();
    subscribeStorageSubject(fn);
    setStorageSubject('leaky'); // fires once, pre-reset
    __resetStorageSubjectForTest();
    expect(isStorageSubjectResolved()).toBe(false);
    expect(getStorageSubject()).toBeNull();
    fn.mockClear();
    setStorageSubject('after-reset');
    expect(fn).not.toHaveBeenCalled(); // the old listener was cleared by reset
  });
});

describe('IDN-3 blocker regression — anonymous/no-auth MUST resolve', () => {
  // The grade-code pass caught that `adoptLocalContentForSubject(null)` from the
  // initial state used to early-return before resolving, stranding every
  // anonymous and no-auth session in `pending` forever.
  it('adoptLocalContentForSubject(null) from the initial state RESOLVES the subject', async () => {
    expect(isStorageSubjectResolved()).toBe(false);
    await adoptLocalContentForSubject(null);
    expect(isStorageSubjectResolved()).toBe(true);
    expect(storageSubjectSnapshot()).toBeNull(); // settled anonymous, not the sentinel
  });

  it('a returning signed-in user resolves to their subject on the first call', async () => {
    await adoptLocalContentForSubject('user-1');
    expect(isStorageSubjectResolved()).toBe(true);
    expect(storageSubjectSnapshot()).toBe('user-1');
  });
});
