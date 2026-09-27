/**
 * ADR 0458 §2.1 — the Challenge Author is provisioned idempotently: one roster
 * instance per workspace, keyed by the stable role, carrying the factory in its
 * assigned workflows and the `challenge-authoring` capability on its profile.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { listRoster } from '../src/host/rosterService.js';
import { getAgentProfile } from '../src/host/agentProfileService.js';
import {
  ensureChallengeAuthor,
  CHALLENGE_AUTHOR_ROLE_KEY,
  CHALLENGE_AUTHOR_ROSTER_ID,
  CHALLENGE_AUTHOR_AGENT_ID,
} from '../src/features/kicktodo-creator/challengeAuthorService.js';
import { CHALLENGE_FACTORY_WORKFLOW_ID } from '../src/features/kicktodo-creator/builtinWorkflows.js';
import { CHALLENGE_AUTHORING_CAPABILITY } from '../src/features/kicktodo-creator/challengeAuthoringCapability.js';

const T = 'tenant-kt-author';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ensureChallengeAuthor (ADR 0458 §2.1)', () => {
  it('provisions a fixed-identity author with the factory assigned + capability active', async () => {
    const author = await ensureChallengeAuthor(T);
    expect(author.rosterId).toBe(CHALLENGE_AUTHOR_ROSTER_ID);
    expect(author.roleKey).toBe(CHALLENGE_AUTHOR_ROLE_KEY);
    expect(author.workflows).toContain(CHALLENGE_FACTORY_WORKFLOW_ID);
    // EXPLICIT heartbeat off + review autonomy — never inherit a running default.
    expect(author.heartbeatIntervalMs).toBe(-1);
    expect(author.autonomyLevel).toBe('review');

    const roster = await listRoster(T);
    const entry = roster.find((e) => e.roleKey === CHALLENGE_AUTHOR_ROLE_KEY);
    expect(entry).toBeDefined();
    expect(entry!.agentRef.agentId).toBe(CHALLENGE_AUTHOR_AGENT_ID);

    const profile = await getAgentProfile(T, CHALLENGE_AUTHOR_ROSTER_ID);
    expect(profile?.capabilities).toContain(CHALLENGE_AUTHORING_CAPABILITY);
  });

  it('is idempotent: two calls (even concurrent) yield ONE roster entry', async () => {
    const [a, b] = await Promise.all([ensureChallengeAuthor(T), ensureChallengeAuthor(T)]);
    expect(a.rosterId).toBe(b.rosterId);
    await ensureChallengeAuthor(T); // a third, sequential
    const authors = (await listRoster(T)).filter((e) => e.roleKey === CHALLENGE_AUTHOR_ROLE_KEY);
    expect(authors).toHaveLength(1);
    // The capability is present exactly once (heal is additive, never duplicative).
    const profile = await getAgentProfile(T, CHALLENGE_AUTHOR_ROSTER_ID);
    expect(profile!.capabilities!.filter((c) => c === CHALLENGE_AUTHORING_CAPABILITY)).toHaveLength(1);
  });
});
