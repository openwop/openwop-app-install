/**
 * ADR 0910 P2 / D7.3 — the operator-access sweep (boot pass + hourly).
 *
 * In a single sweep: expired → one `security.operator-access-expired` audit and one
 * notice per OTHER listed superadmin, then the row is retired; de-listed →
 * `revoked { by: 'eligibility-review' }`; member-less → `revoked { by:
 * 'membership-removed' }`; already revoked → retired with no second audit; a live,
 * listed, member row is untouched. A second sweep writes nothing. Authority never
 * depends on the sweep (that is the P1 use-time test); this pins the record.
 *
 * Regression targets: missing retirement repeats the sweep, notifying the actor
 * breaks the recipient constraint, and auditing revoked rows duplicates revocation.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const audits = vi.hoisted(() => [] as Array<{ tenant: string; kind: string; payload: Record<string, unknown> }>);
const notices = vi.hoisted(() => [] as Array<{ tenantId: string; metadata?: Record<string, unknown> }>);
const auditControl = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/host/auditChainService.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/auditChainService.js')>()),
  appendAudit: async (tenant: string, kind: string, payload: Record<string, unknown>) => { if (auditControl.fail) throw new Error('audit unavailable'); audits.push({ tenant, kind, payload }); return {}; },
}));
vi.mock('../src/notifications/emitter.js', async (orig) => ({
  ...(await orig<typeof import('../src/notifications/emitter.js')>()),
  getNotificationEmitter: () => ({ emit: async (n: { tenantId: string; metadata?: Record<string, unknown> }) => { notices.push(n); } }),
}));

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createMember, createOrg, registerMembershipRootedWorkspaces } from '../src/host/accessControlService.js';
import { isActivationLive, operatorActivations, type OperatorActivation } from '../src/host/operatorActivationLedger.js';
import { listOperatorActivations, sweepOperatorActivations } from '../src/host/operatorAccess.js';
import type { Storage } from '../src/storage/storage.js';
import { setDefaultWorkspaceTargets } from '../src/host/workspaceJoinLedger.js';

const WS = 'host-kicktodo-sweep';
const A = 'user:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // the actor's personal tenant (listed)
const B = 'user:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // another listed superadmin
const NOW = new Date('2026-10-18T12:00:00.000Z');
let storage: Storage;

function row(subject: string, over: Partial<OperatorActivation> = {}): OperatorActivation {
  return {
    activationId: `opa_${subject}`, workspaceId: WS, subject, eligibilityTenant: A, justification: 'a reason here',
    activatedAt: '2026-10-18T09:00:00.000Z', expiresAt: '2026-10-18T17:00:00.000Z', ...over,
  };
}

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerMembershipRootedWorkspaces([WS]);
  setDefaultWorkspaceTargets([{ featureId: 'kicktodo', orgId: WS, tenantId: WS, name: 'Sweep fixture' }]);
  await createOrg({ tenantId: WS, orgId: WS, createdBy: 'system', name: 'Root' });
  for (const s of ['user:live', 'user:expired', 'user:delisted', 'user:revoked']) {
    await createMember({ tenantId: WS, orgId: WS, displayName: s, subject: s, roles: ['viewer'] });
  }
});
beforeEach(() => {
  audits.length = 0;
  notices.length = 0;
  auditControl.fail = false;
  process.env.OPENWOP_SUPERADMIN_TENANTS = `${A},${B}`;
});

describe('ADR 0910 D7.3 — the operator-access sweep', () => {
  it('audits and cleans each ended row exactly once, notifying only the OTHER superadmins', async () => {
    await operatorActivations.put(row('user:live'));
    await operatorActivations.put(row('user:expired', { expiresAt: '2026-10-18T11:00:00.000Z' }));
    await operatorActivations.put(row('user:delisted', { eligibilityTenant: 'user:cccccccccccccccccccccccccccccccc' }));
    await operatorActivations.put(row('user:memberless'));
    await operatorActivations.put(row('user:revoked', { revokedAt: '2026-10-18T10:00:00.000Z', revokedBy: 'user:revoked' }));

    const out = await sweepOperatorActivations(NOW);
    expect(out).toEqual({ expired: 1, delisted: 1, memberless: 1, cleaned: 1 });

    const kinds = audits.map((a) => `${a.kind}:${String(a.payload.subject)}:${String(a.payload.by ?? '')}`).sort();
    expect(kinds).toEqual([
      'security.operator-access-expired:user:expired:',
      'security.operator-access-revoked:user:delisted:eligibility-review',
      'security.operator-access-revoked:user:memberless:membership-removed',
    ]);
    // Each ended activation is told to every listed superadmin EXCEPT its own
    // actor: A's two (expired, member-less) go to B only; the de-listed one's actor
    // (`user:ccc…`) is no longer listed, so both A and B hear of it.
    expect(notices.map((n) => n.tenantId).sort()).toEqual([A, B, B, B].sort());
    expect(notices.some((n) => n.tenantId === A && n.metadata?.activationId === 'opa_user:expired')).toBe(false);

    expect(await operatorActivations.get(`${WS}::user:live`)).not.toBeNull();
    for (const s of ['user:expired', 'user:delisted', 'user:memberless', 'user:revoked']) {
      expect(await operatorActivations.get(`${WS}::${s}`)).toMatchObject({ retiredAt: NOW.toISOString() });
    }
  });

  it('a second sweep writes nothing', async () => {
    const out = await sweepOperatorActivations(NOW);
    expect(out).toEqual({ expired: 0, delisted: 0, memberless: 0, cleaned: 0 });
    expect(audits).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('does not retire or notify for a replacement activated after the sweep read', async () => {
    const old = row('user:live', { expiresAt: '2026-10-18T11:00:00.000Z' });
    const renewed = { ...old, activationId: 'opa_renewed', expiresAt: '2026-10-18T17:00:00.000Z' };
    await operatorActivations.put(old);
    const cas = storage.kvCompareAndSwap.bind(storage);
    let replaced = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (!replaced && args[0].includes('workspace-operator-activation:') && args[0].endsWith('::user:live')) {
        replaced = true;
        expect(await operatorActivations.compareAndSwap(old, renewed)).toBe(true);
      }
      return cas(...args);
    });
    try {
      expect(await sweepOperatorActivations(NOW)).toEqual({ expired: 0, delisted: 0, memberless: 0, cleaned: 0 });
    } finally { spy.mockRestore(); }
    expect(replaced).toBe(true);
    expect(await operatorActivations.get(`${WS}::user:live`)).toEqual(renewed);
    expect(notices).toEqual([]);
  });

  it('concurrent sweeps retire and notify once; retirement stays inactive and can be replaced', async () => {
    const old = row('user:expired', { expiresAt: '2026-10-18T11:00:00.000Z' });
    await operatorActivations.put(old);
    const results = await Promise.all([sweepOperatorActivations(NOW), sweepOperatorActivations(NOW)]);
    expect(results.reduce((n, r) => n + r.expired, 0)).toBe(1);
    expect(notices.filter((n) => n.metadata?.activationId === old.activationId)).toHaveLength(1);
    const retired = await operatorActivations.get(`${WS}::user:expired`);
    expect(retired?.retiredAt).toBe(NOW.toISOString());
    // Even restoring eligibility or rolling the clock back cannot revive it.
    expect(isActivationLive(retired, Date.parse(old.activatedAt))).toBe(false);
    expect((await listOperatorActivations(WS)).some((a) => a.activationId === old.activationId)).toBe(false);
    const fresh = { ...old, activationId: 'opa_fresh', expiresAt: '2026-10-18T17:00:00.000Z' };
    expect(await operatorActivations.compareAndSwap(retired, fresh)).toBe(true);
    expect(isActivationLive(await operatorActivations.get(`${WS}::user:expired`), NOW.getTime())).toBe(true);
  });

  it('leaves a failed audit retryable instead of silently retiring its evidence', async () => {
    const old = row('user:expired', { expiresAt: '2026-10-18T11:00:00.000Z' });
    await operatorActivations.put(old);
    auditControl.fail = true;
    await expect(sweepOperatorActivations(NOW)).rejects.toThrow('audit unavailable');
    expect(await operatorActivations.get(`${WS}::user:expired`)).toEqual(old);
    expect(notices).toEqual([]);
    auditControl.fail = false;
    expect((await sweepOperatorActivations(NOW)).expired).toBe(1);
    expect(audits.filter((a) => a.payload.activationId === old.activationId)).toHaveLength(1);
  });
});
