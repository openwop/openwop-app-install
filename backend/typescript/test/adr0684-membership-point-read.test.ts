/**
 * ADR 0684 phase 5 — the workspace-membership point-read.
 *
 * `isWorkspaceMember` runs on every authenticated request and at session mint,
 * and answered a POINT question with an O(N) slice scan plus a full cross-tenant
 * scan to confirm denials. ADR 0684's default workspace makes N unbounded.
 *
 * The property under test is not speed — it is that the fast path is ADDITIVE:
 * it may answer "yes" and never "no". A missing index entry must fall through to
 * the authoritative paths, because the alternative is locking a real member out
 * of their own workspace, and that is the one direction this must not fail.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createOrg, createMember, deleteMember, isWorkspaceMember, listMembers, rekeyMemberSubject,
} from '../src/host/accessControlService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

/** A workspace-root org: `orgId === tenantId`, the shape isWorkspaceMember matches. */
async function workspace(id: string): Promise<string> {
  await createOrg({ tenantId: id, orgId: id, createdBy: 'system', name: id });
  return id;
}

describe('ADR 0684 phase 5 — membership point-read', () => {
  it('a member resolves true (fast path) and a stranger false', async () => {
    const ws = await workspace('ws:p5a');
    await createMember({ orgId: ws, tenantId: ws, displayName: 'A', subject: 'user:p5a' });
    expect(await isWorkspaceMember('user:p5a', ws)).toBe(true);
    expect(await isWorkspaceMember('user:nobody', ws)).toBe(false);
  });

  it('a REMOVED member resolves false — the index must not outlive the membership', async () => {
    const ws = await workspace('ws:p5b');
    await createMember({ orgId: ws, tenantId: ws, displayName: 'B', subject: 'user:p5b' });
    const m = (await listMembers(ws, ws)).find((x) => x.subject === 'user:p5b');
    await deleteMember(m!.memberId);
    expect(await isWorkspaceMember('user:p5b', ws)).toBe(false);
  });

  it('REKEY moves the entry — the index must not keep asserting the OLD subject', async () => {
    // The failure this guards: rekey runs at session bind, so a stale entry
    // would lie about exactly the subject that just changed, on the path that
    // runs at every mint.
    const ws = await workspace('ws:p5c');
    await createMember({ orgId: ws, tenantId: ws, displayName: 'C', subject: 'oidc:old' });
    expect(await isWorkspaceMember('oidc:old', ws)).toBe(true);

    await rekeyMemberSubject('oidc:old', 'user:new');
    expect(await isWorkspaceMember('user:new', ws)).toBe(true);
    expect(await isWorkspaceMember('oidc:old', ws)).toBe(false);
  });

  it('a membership with NO index entry still resolves true — additive, never authoritative', async () => {
    // Simulates a pre-existing row from before this index shipped. No backfill is
    // required for correctness precisely because of this fall-through; backfill
    // would only widen the fast path.
    const ws = await workspace('ws:p5d');
    await createMember({ orgId: ws, tenantId: ws, displayName: 'D', subject: 'user:p5d' });
    const { __dropMemberIndexForTest } = await import('../src/host/accessControlService.js') as unknown as
      { __dropMemberIndexForTest?: (w: string, s: string) => Promise<void> };
    if (__dropMemberIndexForTest) await __dropMemberIndexForTest(ws, 'user:p5d');
    expect(await isWorkspaceMember('user:p5d', ws)).toBe(true);
  });

  it('a NON-workspace-root membership is not indexed (orgId !== tenantId)', async () => {
    // isWorkspaceMember only matches orgId === tenantId, so indexing a sub-org
    // membership would make the fast path answer "yes" to a question the
    // authoritative path answers "no" — the fast path inventing authority.
    const ws = await workspace('ws:p5e');
    await createOrg({ tenantId: ws, orgId: 'org-sub-p5e', createdBy: 'system', name: 'sub' });
    await createMember({ orgId: 'org-sub-p5e', tenantId: ws, displayName: 'E', subject: 'user:p5e' });
    expect(await isWorkspaceMember('user:p5e', ws)).toBe(false);
  });
});
