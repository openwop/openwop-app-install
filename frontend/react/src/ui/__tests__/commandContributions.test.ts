/**
 * commandContributions tests (ADR 0334 3b-3) — the ⌘K palette contribution seam:
 * register/collect/unregister, a monotonic version for useSyncExternalStore,
 * subscriber notification, replace-by-key, and throw-isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerCommandSource, getContributedCommands, subscribeCommandSources,
  __resetCommandSources, type ContributedCommand,
} from '../commandContributions.js';

const StubIcon = (() => null) as unknown as ContributedCommand['icon'];
const cmd = (id: string): ContributedCommand => ({ id, label: id, hint: '', group: 'g', icon: StubIcon, run: () => {} });

describe('commandContributions', () => {
  beforeEach(() => __resetCommandSources());

  it('collects registered commands and withdraws them on unregister', () => {
    expect(getContributedCommands()).toEqual([]);
    const off = registerCommandSource('a', () => [cmd('a1'), cmd('a2')]);
    expect(getContributedCommands().map((c) => c.id)).toEqual(['a1', 'a2']);
    off();
    expect(getContributedCommands()).toEqual([]);
  });

  it('returns a stable snapshot reference between changes (useSyncExternalStore)', () => {
    registerCommandSource('a', () => [cmd('a1')]);
    const snap1 = getContributedCommands();
    expect(getContributedCommands()).toBe(snap1); // same ref, no change
    registerCommandSource('b', () => [cmd('b1')]);
    expect(getContributedCommands()).not.toBe(snap1); // new ref after a change
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const fn = vi.fn();
    const unsub = subscribeCommandSources(fn);
    const off = registerCommandSource('a', () => [cmd('a1')]);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
    registerCommandSource('b', () => [cmd('b1')]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('replaces a source registered under the same key', () => {
    registerCommandSource('a', () => [cmd('old')]);
    registerCommandSource('a', () => [cmd('new')]);
    expect(getContributedCommands().map((c) => c.id)).toEqual(['new']);
  });

  it('a stale unregister (key re-registered) does not remove the newer source', () => {
    const off1 = registerCommandSource('a', () => [cmd('first')]);
    registerCommandSource('a', () => [cmd('second')]);
    off1(); // must be a no-op — identity guard
    expect(getContributedCommands().map((c) => c.id)).toEqual(['second']);
  });

  it('isolates a throwing source so the palette still gets the rest', () => {
    registerCommandSource('bad', () => { throw new Error('boom'); });
    registerCommandSource('good', () => [cmd('ok')]);
    expect(getContributedCommands().map((c) => c.id)).toEqual(['ok']);
  });
});
