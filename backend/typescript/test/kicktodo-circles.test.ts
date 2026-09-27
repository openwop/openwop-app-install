/**
 * ADR 0419 P1 — circles, grants, and the resource-conversation binding seam:
 *
 *  - a grantee signed into a DIFFERENT tenant accepts + resolves the circle
 *    conversation by OPAQUE id (the owning tenant is resolved server-side and
 *    never returned/accepted from the client)
 *  - uniform 404 for non-members/strangers everywhere (no existence oracle)
 *  - revocation is IMMEDIATE (the next resolve fails)
 *  - a grantee can never broaden scopes; the invitation discloses them
 *  - GENERIC CHAT IS UNWEAKENED: the circle conversation is NOT visible to
 *    the grantee through the ordinary visibility path — access flows ONLY
 *    through the binding seam
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import {
  createCircle,
  inviteToCircle,
  acceptGrant,
  revokeGrant,
  resolveCircleConversation,
  liveGrant,
  CircleDeniedError,
} from '../src/features/kicktodo-accountability/circleService.js';
import { getConversationMeta } from '../src/host/conversationStore.js';
import { isVisibleTo } from '../src/host/conversationVisibility.js';

const OWNER_TENANT = 'tenant-circle-owner';
const ALICE = 'user:circle-alice';
const BOB = 'user:circle-bob'; // lives in ANOTHER workspace entirely

let circleId = '';
let conversationId = '';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: OWNER_TENANT, title: 'Shared Focus', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(OWNER_TENANT, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: OWNER_TENANT, ownerSubject: ALICE, challengeId: draft.id, challengeVersion: 1 });
  const circle = await createCircle({ tenantId: OWNER_TENANT, type: 'partner', enrollmentId: enrollment.id, ownerSubject: ALICE, name: 'Alice & Bob' });
  circleId = circle.id;
  conversationId = circle.conversationId;
});

describe('grants + the binding seam', () => {
  it('invite (scopes disclosed) → accept from ANOTHER tenant → resolve by opaque id', async () => {
    const invite = await inviteToCircle(OWNER_TENANT, circleId, ALICE, BOB, ['action-status', 'message']);
    expect(invite.state).toBe('invited');
    expect(invite.scopes).toEqual(['action-status', 'message']); // the disclosure

    // Bob is NOT in the owner tenant — accept + resolve go by opaque id only.
    const accepted = await acceptGrant(circleId, BOB);
    expect(accepted.state).toBe('active');

    const bound = await resolveCircleConversation(circleId, BOB);
    expect(bound.tenantId).toBe(OWNER_TENANT); // server-side resolution
    expect(bound.conversationId).toBe(conversationId);
    expect(bound.scopes).toEqual(['action-status', 'message']);
  });

  it('GENERIC CHAT UNWEAKENED: the circle conversation is invisible to the grantee via the ordinary visibility path', async () => {
    const meta = await getConversationMeta(OWNER_TENANT, conversationId);
    expect(meta).not.toBeNull();
    // Bob holds a LIVE grant (the seam admits him) — but the generic
    // visibility check does NOT (he is not a participant of the meta): proof
    // that the binding seam is the ONLY door and chat tenancy is intact.
    expect(await liveGrant(OWNER_TENANT, circleId, BOB)).not.toBeNull();
    expect(isVisibleTo(meta, BOB.replace(/^user:/, ''))).toBe(false);
    expect(isVisibleTo(meta, BOB)).toBe(false);
  });

  it('uniform 404: strangers and unknown ids are indistinguishable', async () => {
    await expect(resolveCircleConversation(circleId, 'user:mallory')).rejects.toBeInstanceOf(CircleDeniedError);
    await expect(resolveCircleConversation('circle:nope', BOB)).rejects.toBeInstanceOf(CircleDeniedError);
    await expect(acceptGrant(circleId, 'user:mallory')).rejects.toBeInstanceOf(CircleDeniedError);
  });

  it('revocation is immediate; the grantee can also leave themself', async () => {
    await revokeGrant(OWNER_TENANT, circleId, ALICE, BOB);
    await expect(resolveCircleConversation(circleId, BOB)).rejects.toBeInstanceOf(CircleDeniedError);
    expect(await liveGrant(OWNER_TENANT, circleId, BOB)).toBeNull();

    // Re-invite; Bob leaves himself (actor === grantee is allowed).
    await inviteToCircle(OWNER_TENANT, circleId, ALICE, BOB, ['action-status']);
    await acceptGrant(circleId, BOB);
    await revokeGrant(OWNER_TENANT, circleId, BOB, BOB);
    await expect(resolveCircleConversation(circleId, BOB)).rejects.toBeInstanceOf(CircleDeniedError);
  });

  it('only the owner invites; a grantee cannot broaden anything', async () => {
    await expect(inviteToCircle(OWNER_TENANT, circleId, BOB, 'user:carol', ['message'])).rejects.toBeInstanceOf(CircleDeniedError);
  });
});
