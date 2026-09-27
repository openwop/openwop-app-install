/**
 * ADR 0684 §7 phase 2 — auto-join gates on the ACTION, never on membership.
 *
 * The removal test is the point of this file. Gating on membership would make an
 * operator's removal mean "removed until they next sign in" — and since the
 * default participant workspace is the one everybody is in, a removal there is an
 * abuse control, not org hygiene. A silently-rejoining banned participant is the
 * failure this design exists to make impossible.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { autoJoinDefaultWorkspaces, hasJoined, claimJoin } from '../src/host/workspaceJoinLedger.js';
import { createOrg, listMembers, deleteMember } from '../src/host/accessControlService.js';
import { resolveActiveWorkspace } from '../src/host/activeWorkspacePref.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

// Workspace-root ids: org === tenant (ADR 0684 correction). These were
// `host-${n}` / `host:${n}`, which no workspace predicate can match.
const target = (n: string) => ({ featureId: `f-${n}`, orgId: `host-${n}`, tenantId: `host-${n}`, name: n });

/** Auto-join is toggle-gated at sign-in (ADR 0684 §7), so a target only sweeps
 *  anyone when its feature is ON for that subject. */
const withToggleOn = async (t: ReturnType<typeof target>) => {
  // A DECLARED default, not a stored override: `getEffectiveConfig` ignores an
  // override whose feature declares nothing (a graduated feature must not
  // reappear), so a stored row alone leaves the gate closed.
  registerToggleDefault({ id: t.featureId, label: t.name, status: 'on', bucketUnit: 'user', salt: t.featureId } as never);
  return t;
};

describe('ADR 0684 §7 — the join ledger', () => {
  it('claimJoin is won exactly once', async () => {
    expect(await claimJoin({ subject: 'user:a', workspaceId: 'host-l1', orgId: 'host-l1' })).toBe(true);
    expect(await claimJoin({ subject: 'user:a', workspaceId: 'host-l1', orgId: 'host-l1' })).toBe(false);
    expect(await hasJoined('user:a', 'host-l1')).toBe(true);
  });

  it('is keyed per (subject, workspace) — one does not imply the other', async () => {
    await claimJoin({ subject: 'user:b', workspaceId: 'host-l2', orgId: 'host-l2' });
    expect(await hasJoined('user:b', 'host-l3')).toBe(false);
    expect(await hasJoined('user:c', 'host-l2')).toBe(false);
  });
});

describe('ADR 0684 §7 — auto-join', () => {
  it('joins the subject and makes the workspace active', async () => {
    const t = await withToggleOn(target('aj1'));
    await createOrg({ tenantId: t.tenantId, orgId: t.orgId, createdBy: 'system', name: t.name });
    expect(await autoJoinDefaultWorkspaces('user:j1', 'J One', 'user:j1', [t])).toBe(1);
    expect((await listMembers(t.tenantId, t.orgId)).some((m) => m.subject === 'user:j1')).toBe(true);
    // `resolveActiveWorkspace` is FAIL-CLOSED: it honours the stored preference
    // only after re-confirming membership, so this asserts the preference AND
    // that membership backs it — the same pairing a session mint performs.
    expect(await resolveActiveWorkspace('user:j1', 'user:j1-personal', async () => true)).toBe(t.tenantId);
    // ...and with membership revoked, the preference is NOT honoured.
    expect(await resolveActiveWorkspace('user:j1', 'user:j1-personal', async () => false)).toBe('user:j1-personal');
  });

  it('is idempotent — a second sign-in joins nothing', async () => {
    const t = await withToggleOn(target('aj2'));
    await createOrg({ tenantId: t.tenantId, orgId: t.orgId, createdBy: 'system', name: t.name });
    expect(await autoJoinDefaultWorkspaces('user:j2', 'J Two', 'user:j2', [t])).toBe(1);
    expect(await autoJoinDefaultWorkspaces('user:j2', 'J Two', 'user:j2', [t])).toBe(0);
    expect((await listMembers(t.tenantId, t.orgId)).filter((m) => m.subject === 'user:j2')).toHaveLength(1);
  });

  it('REMOVAL WINS — a removed participant is not silently re-joined (the ban path)', async () => {
    const t = await withToggleOn(target('aj3'));
    await createOrg({ tenantId: t.tenantId, orgId: t.orgId, createdBy: 'system', name: t.name });
    await autoJoinDefaultWorkspaces('user:banned', 'Banned', 'user:banned', [t]);

    // The operator removes them — abuse, spam, a ban.
    const m = (await listMembers(t.tenantId, t.orgId)).find((x) => x.subject === 'user:banned');
    expect(m).toBeTruthy();
    await deleteMember(m!.memberId);
    expect((await listMembers(t.tenantId, t.orgId)).some((x) => x.subject === 'user:banned')).toBe(false);

    // They sign in again. Gating on MEMBERSHIP would re-add them here, silently.
    expect(await autoJoinDefaultWorkspaces('user:banned', 'Banned', 'user:banned', [t])).toBe(0);
    expect((await listMembers(t.tenantId, t.orgId)).some((x) => x.subject === 'user:banned')).toBe(false);
  });

  it('FAILS CLOSED without a tenant to resolve the toggle against — no sweep', async () => {
    // The toggle is only askable when a request context exists. With none, the
    // honest answer is "cannot tell", and the safe one is "do not sweep".
    const t = await withToggleOn(target('aj5'));
    await createOrg({ tenantId: t.tenantId, orgId: t.orgId, createdBy: 'system', name: t.name });
    expect(await autoJoinDefaultWorkspaces('user:j5', 'J Five', undefined, [t])).toBe(0);
    expect((await listMembers(t.tenantId, t.orgId)).some((m) => m.subject === 'user:j5')).toBe(false);
  });

  it('never throws — a failed join must not fail a sign-in', async () => {
    // No org exists for this target, so createMember's org lookup has nothing to
    // bind to. The contract is that the caller (the OIDC bind route) still returns.
    await expect(autoJoinDefaultWorkspaces('user:j4', 'J Four', 'user:j4', [target('missing-org')])).resolves.toBeTypeOf('number');
  });
});
