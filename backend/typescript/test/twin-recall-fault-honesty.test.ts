/**
 * ADR 0666 D3 — a faulted authorization read must not present as "not granted".
 *
 * BORN RED. `resolveBorrowedRecall` wrapped its toggle read in `catch { on = false }` and then
 * returned the same silent closure a genuine opt-out returns. It stayed fail-closed on CONTENT;
 * the defect was silence — the closure reason is log-only and never crosses the seam, so no lane
 * could distinguish a tenant that opted out from a config store that was down. The rule is
 * written in the sentinel ~90 lines away in `host/agentRunnerNode.ts`.
 *
 * The discrimination is the point, so both directions are pinned: a clean `false` still closes
 * SILENTLY (nothing to disclose about a feature nobody enabled), and a FAULT discloses only when
 * the person actually holds a grant.
 */
import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

const T = 'tFaultHonesty';
let AGENT = '';   // the roster id, minted in the seed (the resolver keys on it)
const OWNER = 'user:0123456789abcdef0123456789abcdef';

// The toggle resolver is the fault injection point.
const resolveOne = vi.hoisted(() => vi.fn());
vi.mock('../src/host/featureToggles/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/featureToggles/service.js')>();
  return { ...actual, resolveOne };
});

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0666-fault-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
afterEach(() => resolveOne.mockReset());

let storage: Awaited<ReturnType<typeof openStorage>>;

/** Seed a REAL roster entry + link + grant — the shapes production has. `linkTwin` refuses an
 *  agent that does not exist, which is itself the fail-closed behaviour, so the fixture must be
 *  real rather than stubbed. */
async function seedLinkAndGrant(): Promise<string> {
  const { linkTwin, grantTwin } = await import('../src/host/twinService.js');
  const { createRosterEntry } = await import('../src/host/rosterService.js');
  const entry = await createRosterEntry({ tenantId: T, persona: `Aide ${Math.random().toString(16).slice(2, 8)}`, agentRef: { agentId: 'a.b.c.d' } });
  await linkTwin(storage, T, entry.rosterId, OWNER, OWNER);
  await grantTwin(storage, T, entry.rosterId, OWNER, ['memory']);
  return entry.rosterId;
}

describe('ADR 0666 D3 — "off" and "unreadable" are different answers', () => {
  it('a CLEAN false closes silently AND reads nothing else — the early return, asserted', async () => {
    // Sharpened after a load-induced timeout exposed that this leg was ALSO weak: it seeded a
    // roster entry (three durable writes) to assert `undefined`, which `not-linked` also
    // returns — so the seed cost time and proved nothing the born-red leg did not.
    //
    // The property that actually matters here is the EARLY RETURN: when the feature is cleanly
    // off, nothing further is read. That is what keeps the main path untouched by D3, and it is
    // the 1-durable-read cost claim for the common case. Asserted with a spy instead of a
    // fixture — faster, and it fails if anyone ever lets the off case fall through.
    const twin = await import('../src/host/twinService.js');
    const linkSpy = vi.spyOn(twin, 'getTwinLink');
    resolveOne.mockResolvedValue({ enabled: false });
    try {
      const { resolveBorrowedRecall } = await import('../src/features/twin/borrowedRecall.js');
      expect(await resolveBorrowedRecall(T, 'any.agent', { callerUserId: OWNER })).toBeUndefined();
      expect(linkSpy, 'a cleanly-off toggle must not read the link at all').not.toHaveBeenCalled();
    } finally { linkSpy.mockRestore(); }
  });

  it('BORN RED — a FAULTED toggle read with a live grant degrades and FIRES the sink', async () => {
    AGENT = await seedLinkAndGrant();
    resolveOne.mockRejectedValue(new Error('toggle store down'));
    const { resolveBorrowedRecall } = await import('../src/features/twin/borrowedRecall.js');

    const source = await resolveBorrowedRecall(T, AGENT, { callerUserId: OWNER });
    expect(source, 'a faulted read must NOT present as "not granted"').toBeTruthy();

    // The seam contract every lane already consumes: the sink fires, so the model is told the
    // corpus could not be READ rather than being handed silence.
    const fired: string[] = [];
    const chunks = await source!.retrieve('anything', (s) => fired.push(s));
    expect(fired, 'the degradation sink must fire').toContain('kb');
    expect(chunks, 'fail-closed on content — no chunks').toEqual([]);
  });

  it('a FAULTED toggle read on a LINKED agent with NO grant still closes silently', async () => {
    // CORRECTED after the it.17 grade-code pass — this leg was VACUOUS. It passed a roster id
    // that does not exist, so it exited at `not-linked` and never reached the grant check at
    // all: deleting the no-grant early return would have left it green. The property is
    // "linked, but no grant ⇒ silence", so the fixture must actually be LINKED.
    const { linkTwin } = await import('../src/host/twinService.js');
    const { createRosterEntry } = await import('../src/host/rosterService.js');
    const entry = await createRosterEntry({ tenantId: T, persona: `Aide nogrant ${Math.random().toString(16).slice(2, 8)}`, agentRef: { agentId: 'a.b.c.d' } });
    await linkTwin(storage, T, entry.rosterId, OWNER, OWNER);   // linked…
    // …and deliberately NOT granted.
    resolveOne.mockRejectedValue(new Error('toggle store down'));
    const { resolveBorrowedRecall } = await import('../src/features/twin/borrowedRecall.js');
    expect(await resolveBorrowedRecall(T, entry.rosterId, { callerUserId: OWNER })).toBeUndefined();
  });

  it('a FAULTED toggle read whose LINK read also faults closes silently — not a false owner notice', async () => {
    // The correlated-outage case, and the reason D3 was restructured. The store that fails the
    // toggle read usually fails the link read too; letting that throw escape turned every
    // ordinary agent in a tenant that never enabled the feature into a claim that its OWNER'S
    // corpus could not be read. There is no owner. Silence is the only honest answer when the
    // grant cannot be established.
    resolveOne.mockRejectedValue(new Error('toggle store down'));
    const twin = await import('../src/host/twinService.js');
    const spy = vi.spyOn(twin, 'getTwinLink').mockRejectedValue(new Error('hostext store down'));
    try {
      const { resolveBorrowedRecall } = await import('../src/features/twin/borrowedRecall.js');
      expect(await resolveBorrowedRecall(T, 'any.agent', { callerUserId: OWNER })).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('the arity contract survives the new branch (WF-TWIN-2 — do not re-narrow)', async () => {
    AGENT = await seedLinkAndGrant();
    resolveOne.mockRejectedValue(new Error('toggle store down'));
    const { resolveBorrowedRecall } = await import('../src/features/twin/borrowedRecall.js');
    const source = await resolveBorrowedRecall(T, AGENT, { callerUserId: OWNER });
    // A 1-ary retriever is assignable and would silently swallow the sink — the GEN-RCL-1 shape.
    expect(source!.retrieve.length, 'the sentinel must DECLARE onSourceError').toBeGreaterThanOrEqual(2);
  });
});
