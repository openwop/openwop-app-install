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

let challengeId = '';
let seq = 0;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: OWNER_TENANT, title: 'Shared Focus', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(OWNER_TENANT, draft.id, 1);
  challengeId = draft.id;
});

/** A circle of the case's own (owner ALICE, fresh enrollment), optionally with BOB
 *  invited + accepted at `bobScopes`. */
async function freshCircle(bobScopes?: Array<'action-status' | 'message'>): Promise<{ circleId: string; conversationId: string }> {
  seq += 1;
  // A distinct owner per circle so the enrollment is fresh; ALICE stays the circle owner.
  const { enrollment } = await enroll({ tenantId: OWNER_TENANT, ownerSubject: `${ALICE}-${seq}`, challengeId, challengeVersion: 1 });
  const circle = await createCircle({ tenantId: OWNER_TENANT, type: 'partner', enrollmentId: enrollment.id, ownerSubject: ALICE, name: `Alice & Bob ${seq}` });
  if (bobScopes) {
    await inviteToCircle(OWNER_TENANT, circle.id, ALICE, BOB, bobScopes);
    await acceptGrant(circle.id, BOB);
  }
  return { circleId: circle.id, conversationId: circle.conversationId };
}

describe('grants + the binding seam', () => {
  it('invite (scopes disclosed) → accept from ANOTHER tenant → resolve by opaque id', async () => {
    const { circleId, conversationId } = await freshCircle();
    const invite = await inviteToCircle(OWNER_TENANT, circleId, ALICE, BOB, ['action-status', 'message']);
    expect(invite.state).toBe('invited');
    expect(invite.scopes).toEqual(['action-status', 'message']); // the disclosure
    // Not yet accepted ⇒ the seam does not admit him.
    await expect(resolveCircleConversation(circleId, BOB)).rejects.toBeInstanceOf(CircleDeniedError);

    // Bob is NOT in the owner tenant — accept + resolve go by opaque id only.
    const accepted = await acceptGrant(circleId, BOB);
    expect(accepted.state).toBe('active');

    const bound = await resolveCircleConversation(circleId, BOB);
    expect(bound.tenantId).toBe(OWNER_TENANT); // server-side resolution
    expect(bound.conversationId).toBe(conversationId);
    expect(bound.scopes).toEqual(['action-status', 'message']);
  });

  it('GENERIC CHAT UNWEAKENED: the circle conversation is invisible to the grantee via the ordinary visibility path', async () => {
    const { circleId, conversationId } = await freshCircle(['action-status', 'message']);
    const meta = await getConversationMeta(OWNER_TENANT, conversationId);
    if (!meta) throw new Error('the circle conversation meta must exist');
    // Bob holds a LIVE grant (the seam admits him) — but the generic
    // visibility check does NOT (he is not a participant of the meta): proof
    // that the binding seam is the ONLY door and chat tenancy is intact.
    expect(await liveGrant(OWNER_TENANT, circleId, BOB)).not.toBeNull();
    expect(isVisibleTo(meta, BOB.replace(/^user:/, ''))).toBe(false);
    expect(isVisibleTo(meta, BOB)).toBe(false);
    // Positive control: the owner DOES see it through the same path.
    expect(isVisibleTo(meta, ALICE)).toBe(true);
  });

  it('uniform 404: strangers and unknown ids are indistinguishable', async () => {
    const { circleId } = await freshCircle(['action-status']);
    expect((await resolveCircleConversation(circleId, BOB)).tenantId).toBe(OWNER_TENANT); // positive control
    await expect(resolveCircleConversation(circleId, 'user:mallory')).rejects.toThrow(new CircleDeniedError());
    await expect(resolveCircleConversation('circle:nope', BOB)).rejects.toThrow(new CircleDeniedError());
    await expect(acceptGrant(circleId, 'user:mallory')).rejects.toThrow(new CircleDeniedError());
  });

  it('revocation is immediate; the grantee can also leave themself', async () => {
    const { circleId } = await freshCircle(['action-status', 'message']);
    expect((await resolveCircleConversation(circleId, BOB)).tenantId).toBe(OWNER_TENANT); // admitted before
    await revokeGrant(OWNER_TENANT, circleId, ALICE, BOB);
    await expect(resolveCircleConversation(circleId, BOB)).rejects.toBeInstanceOf(CircleDeniedError);
    expect(await liveGrant(OWNER_TENANT, circleId, BOB)).toBeNull();
    // A revoked grantee cannot simply re-accept their way back in.
    await expect(acceptGrant(circleId, BOB)).rejects.toBeInstanceOf(CircleDeniedError);

    // Re-invite; Bob leaves himself (actor === grantee is allowed).
    await inviteToCircle(OWNER_TENANT, circleId, ALICE, BOB, ['action-status']);
    await acceptGrant(circleId, BOB);
    expect((await resolveCircleConversation(circleId, BOB)).scopes).toEqual(['action-status']);
    await revokeGrant(OWNER_TENANT, circleId, BOB, BOB);
    await expect(resolveCircleConversation(circleId, BOB)).rejects.toBeInstanceOf(CircleDeniedError);
  });

  it('only the owner invites; a grantee cannot broaden anything', async () => {
    const { circleId } = await freshCircle(['action-status']);
    await expect(inviteToCircle(OWNER_TENANT, circleId, BOB, 'user:carol', ['message'])).rejects.toBeInstanceOf(CircleDeniedError);
    expect(await liveGrant(OWNER_TENANT, circleId, 'user:carol')).toBeNull();
    // Positive control: the owner's identical invite succeeds.
    expect((await inviteToCircle(OWNER_TENANT, circleId, ALICE, 'user:carol', ['message'])).state).toBe('invited');
  });
});
