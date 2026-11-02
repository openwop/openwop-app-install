/**
 * `feature.notifications.nodes.notify` + the `ctx.features.notifications` surface.
 *
 * THE DEFECT THIS REPLACES. 55 chain nodes across 53 packs used
 * `core.openwop.integration.notification-push`, whose input schema requires a
 * per-recipient `deviceToken`. Zero bound it — none could — so the adapter POSTed
 * `to: undefined`, errored, and the node returned `status:'success'` with
 * `sent:false`. A run whose only outbound action failed completed GREEN.
 *
 * So the assertions that matter here are the REFUSALS: every path that cannot
 * deliver must say so in `emitted:false` + a reason, and must never be reportable
 * as a delivery.
 *
 * Scope: this file stops at `emit` (mocked). That `emitter.buildRecord` keeps
 * `recipientRole` on the stored row is `notifications-emitter-record-fields.test.ts`.
 *
 * Sabotage witnessed (grade-tests w74, TST-DVA-3): each refusal `return` in
 * `features/notifications/surface.ts` replaced by an emit, the `self`/`role:`
 * targets emptied, `urgent` dropped from PRIORITIES, the pack collapsing
 * `emitted` to true, the pack's surface guard removed, and the pack's typeId
 * renamed in pack.json (the reachability case) — each reds its case.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { buildNotificationsSurface } from '../src/features/notifications/surface.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import type { getNotificationEmitter } from '../src/notifications/emitter.js';

/** The emitter's own input type (`RecordInput` is module-private). */
type EmitInput = Parameters<ReturnType<typeof getNotificationEmitter>['emit']>[0];
interface NotifyNodeResult { status: string; outputs: { emitted?: unknown; audience?: unknown; reason?: unknown } }
interface NotificationsPack { notify: (ctx: unknown) => Promise<NotifyNodeResult> }
/** Loaded the way the runtime does (an untyped .mjs), through a computed URL. */
async function loadPack(): Promise<NotificationsPack> {
  return (await import(new URL('../../../packs/feature.notifications.nodes/index.mjs', import.meta.url).href)) as NotificationsPack;
}

// Mocks `emit` — the DURABLE path (inbox row + SSE + Web Push + Teams). An
// earlier cut called `signal()`, which is transient and reaches only a live SSE
// listener; the /grade-data pass caught it. Asserting on `emit` keeps that fix pinned.
const signal = vi.fn<(rec: EmitInput) => Promise<void>>();
vi.mock('../src/notifications/emitter.js', () => ({
  getNotificationEmitter: () => ({ emit: async (rec: EmitInput) => { await signal(rec); } }),
}));

const scopeOf = (over: Partial<BundleScope> = {}): BundleScope => ({ tenantId: 'user:t1', runId: 'run-1', ...over });
/** The one record handed to `emit` (asserts there was exactly one). */
function emitted(): EmitInput {
  expect(signal).toHaveBeenCalledTimes(1);
  return signal.mock.calls[0]![0];
}

/** Drive the pack node, not just the surface — the wiring is half the contract. */
async function viaNode(scope: BundleScope, config: Record<string, unknown>, inputs: Record<string, unknown>) {
  const { notify } = await loadPack();
  return notify({ features: { notifications: buildNotificationsSurface(scope) }, config, inputs });
}

// mockReset, not mockClear: a queued mockImplementationOnce must never answer a later case.
beforeEach(() => signal.mockReset());

describe('audience is explicit — the three ADR 0050 modes', () => {
  it('tenant → a broadcast row (no recipient field at all)', async () => {
    const out = await viaNode(scopeOf(), { audience: 'tenant' }, { title: 'Digest ready' });
    expect(out.outputs.emitted).toBe(true);
    const rec = emitted();
    expect(rec.recipientUserId).toBeUndefined();
    expect(rec.recipientRole).toBeUndefined();
    // The whole record: no recipient key at all, and the deep link derived from the run.
    expect(rec).toEqual({
      tenantId: 'user:t1', type: 'workflow.notice', priority: 'normal', title: 'Digest ready', message: '',
      runId: 'run-1', actionUrl: '/runs/run-1',
    });
  });

  it('self → addressed to the run’s acting user', async () => {
    const out = await viaNode(scopeOf({ actingUserId: 'u-42' }), { audience: 'self' }, { title: 'Yours' });
    expect(out.outputs.emitted).toBe(true);
    expect(emitted().recipientUserId).toBe('u-42');
  });

  it('role:<name> → addressed to the role, and the field reaches the emitter', async () => {
    const out = await viaNode(scopeOf(), { audience: 'role:admin' }, { title: 'Quota' });
    expect(out.outputs.emitted).toBe(true);
    // `emitter.buildRecord` used to DROP `recipientRole`, which would have turned
    // every role-addressed notice into a tenant-wide broadcast — the inverse of
    // ADR 0050's default-deny guarantee. This file asserts the field reaches `emit`;
    // that buildRecord keeps it is notifications-emitter-record-fields.test.ts.
    const rec = emitted();
    expect(rec.recipientRole).toBe('admin');
    expect(rec.recipientUserId).toBeUndefined();
  });
});

describe('every undeliverable path REFUSES rather than reporting success', () => {
  it('self on a run with NO acting human (schedule / webhook) refuses', async () => {
    const out = await viaNode(scopeOf({ actingUserId: undefined }), { audience: 'self' }, { title: 'x' });
    expect(out.outputs.emitted).toBe(false);
    expect(out.outputs.reason).toBe('no_acting_user_on_this_run');
    // The whole point: it did NOT quietly broadcast to the tenant instead.
    expect(signal).not.toHaveBeenCalled();
  });

  it('an unknown audience refuses instead of defaulting to a broadcast', async () => {
    const out = await viaNode(scopeOf(), { audience: 'everyone' }, { title: 'x' });
    expect(out.outputs.emitted).toBe(false);
    expect(out.outputs.reason).toBe('unknown_audience');
    expect(signal).not.toHaveBeenCalled();
  });

  it('a missing audience refuses (it is never inferred from the run)', async () => {
    const out = await viaNode(scopeOf({ actingUserId: 'u-1' }), {}, { title: 'x' });
    expect(out.outputs.emitted).toBe(false);
    expect(out.outputs.reason).toBe('audience_required');
    expect(signal).not.toHaveBeenCalled();
  });

  it('a missing title refuses — an untitled inbox row is not a notification', async () => {
    const out = await viaNode(scopeOf(), { audience: 'tenant' }, {});
    expect(out.outputs.emitted).toBe(false);
    expect(out.outputs.reason).toBe('title_required');
    expect(signal).not.toHaveBeenCalled();
  });

  it('a bare `role:` refuses', async () => {
    const out = await viaNode(scopeOf(), { audience: 'role:' }, { title: 'x' });
    expect(out.outputs.emitted).toBe(false);
    expect(out.outputs.reason).toBe('role_required');
    expect(signal).not.toHaveBeenCalled();
  });

  it('an emitter throw is reported, never swallowed into a success', async () => {
    signal.mockImplementationOnce(() => { throw new Error('backend down'); });
    const out = await viaNode(scopeOf(), { audience: 'tenant' }, { title: 'x' });
    expect(out.outputs.emitted).toBe(false);
    expect(out.outputs.reason).toBe('emitter_error');
    // The throw came from the real emit call, not an earlier refusal.
    expect(signal).toHaveBeenCalledTimes(1);
  });
});

describe('priority', () => {
  it('honours `urgent` — the union has four values, not three', async () => {
    // The first cut hand-listed {low, normal, high} and would have silently
    // DOWNGRADED urgent to normal; tsc caught it against NotificationPriority.
    const out = await viaNode(scopeOf(), { audience: 'tenant', priority: 'urgent' }, { title: 'x' });
    expect(out.outputs.emitted).toBe(true);
    expect(emitted().priority).toBe('urgent');
  });

  it('falls back to normal for an unrecognised value', async () => {
    const out = await viaNode(scopeOf(), { audience: 'tenant', priority: 'nonsense' }, { title: 'x' });
    expect(out.outputs.emitted).toBe(true);
    expect(emitted().priority).toBe('normal');
  });
});

/**
 * REACHABILITY. A pack on disk is not a pack in the catalog: `buildNodeCatalog`
 * scans the MOUNT dir (`~/.openwop-packs`), not this repo's `packs/`, so a node is
 * only referenceable after `ensureLocalPacksMounted` runs at boot. Phase B
 * (retargeting 53 chains onto this typeId) depends entirely on that — an
 * unreferenceable typeId makes every retargeted chain fail
 * `chain_unresolvable_typeid` at load. A green unit suite says the node works; it
 * says nothing about whether anything can reach it.
 */
describe('the node is REACHABLE, not merely present on disk', () => {
  it('appears in the node catalog after the boot-time mount, with its host surface satisfied', async () => {
    const { ensureLocalPacksMounted } = await import('../src/bootstrap/mountLocalPacks.js');
    const { buildNodeCatalog } = await import('../src/host/nodeCatalogBuilder.js');
    ensureLocalPacksMounted();
    const node = buildNodeCatalog().find((n) => n.typeId === 'feature.notifications.nodes.notify');
    expect(node, 'not in the catalog ⇒ no chain can reference it').toBeTruthy();
    expect(node?.missingHostSurfaces ?? [], 'a missing host surface excludes it from authoring').toEqual([]);
  });
});

describe('the node fails loudly when the surface is absent', () => {
  it('throws host_capability_missing rather than pretending it notified', async () => {
    const { notify } = await loadPack();
    await expect(notify({ features: {}, config: { audience: 'tenant' }, inputs: { title: 'x' } }))
      .rejects.toThrow(/ctx\.features\.notifications/);
  });
});
