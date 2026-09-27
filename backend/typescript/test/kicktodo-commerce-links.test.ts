/**
 * ADR 0420 (admin link surface) — the operator's view of what is for sale, and the
 * two rules the surface adds:
 *  - `listChallengeLinks` lists the tenant's product→challenge links (and nothing
 *    of another tenant's);
 *  - `unlinkChallengeProduct` stops selling without touching a granted entitlement
 *    (a buyer keeps what they paid for);
 *  - `relinkConflict` refuses a SILENT relink to a different challenge version unless
 *    the caller says `replace`, and is idempotent for the same version.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import {
  linkChallengeProduct, listChallengeLinks, unlinkChallengeProduct, getLinkByProduct, relinkConflict, isChallengePaid, LinkError,
} from '../src/features/kicktodo-commerce/entitlementService.js';

const T = 'tenant-links';
const OTHER = 'tenant-links-other';
let challengeId = '';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  for (const tenant of [T, OTHER]) {
    const draft = await createDraft({
      tenantId: tenant, title: 'Sellable', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 'a', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(tenant, draft.id, 1);
    if (tenant === T) challengeId = draft.id;
    await linkChallengeProduct(tenant, `prod:${tenant}`, draft.id, 1, 'user:op');
  }
});

describe('challenge links — the operator surface (ADR 0420)', () => {
  it('lists only the tenant’s links, and unlink stops the sale without an error on a second call', async () => {
    const mine = await listChallengeLinks(T);
    expect(mine.map((l) => l.productId)).toEqual([`prod:${T}`]);
    expect(await isChallengePaid(T, challengeId, 1)).toBe(true);
    expect(await unlinkChallengeProduct(T, `prod:${T}`)).toBe(true);
    expect(await getLinkByProduct(T, `prod:${T}`)).toBeNull();
    expect(await isChallengePaid(T, challengeId, 1)).toBe(false); // free again on the next enrol
    expect(await unlinkChallengeProduct(T, `prod:${T}`)).toBe(false); // honest: nothing to remove
    // The other tenant's link is untouched.
    expect((await listChallengeLinks(OTHER)).map((l) => l.productId)).toEqual([`prod:${OTHER}`]);
  });

  it('relinkConflict: same version idempotent; different version refused unless replace; no link ⇒ proceed', async () => {
    const link = await linkChallengeProduct(T, 'prod:relink', challengeId, 1, 'user:op');
    expect(relinkConflict(null, { challengeId: 'x', challengeVersion: 9 })).toBeNull();
    expect(relinkConflict(link, { challengeId, challengeVersion: 1 })).toBeNull();
    expect(relinkConflict(link, { challengeId: 'chal:other', challengeVersion: 2 })).toMatch(/already sells/);
    expect(relinkConflict(link, { challengeId: 'chal:other', challengeVersion: 2, replace: true })).toBeNull();
  });

  it('a link still refuses an unpublished version (unchanged rule)', async () => {
    await expect(linkChallengeProduct(T, 'prod:never', 'chal:missing', 1, 'user:op')).rejects.toBeInstanceOf(LinkError);
  });
});
