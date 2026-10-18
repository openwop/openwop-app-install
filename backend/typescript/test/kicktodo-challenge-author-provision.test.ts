/**
 * ADR 0458 §2.1 — the Challenge Author is provisioned idempotently: one roster
 * instance per workspace, keyed by the stable role, carrying the factory in its
 * assigned workflows and the `challenge-authoring` capability on its profile.
 *
 * Expected values are LITERALS (never the product's own constants), so a renamed
 * id reds here instead of moving with the oracle.
 *
 * Convergence is guarded THREE ways, each witnessed on its own:
 *  - in-process SINGLE-FLIGHT (`ensuring` map): two calls in flight share ONE
 *    provisioning promise — witnessed by result identity (sabotage: drop the
 *    `if (inflight) return inflight` early return);
 *  - the CATCH-CONVERGE in `provision`: a create that loses to a concurrent winner
 *    (409 on the deterministic `host:challenge-author` id) re-reads and converges —
 *    witnessed by forcing the lost race (the first role lookup misses, so the saga
 *    attempts a create the existing row refuses); sabotage: always rethrow;
 *  - the roster's insert-if-absent CAS on the deterministic id makes a second ROW
 *    impossible by construction — so the row count is a by-construction pin, not a
 *    witness of either guard above.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { listRoster } from '../src/host/rosterService.js';
import { getAgentProfile } from '../src/host/agentProfileService.js';
import { ensureChallengeAuthor } from '../src/features/kicktodo-creator/challengeAuthorService.js';

vi.mock('../src/host/rosterService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/rosterService.js')>();
  return { ...actual, listRoster: vi.fn(actual.listRoster) };
});

const T = 'tenant-kt-author';
const ROLE = 'kicktodo-challenge-author';
const ROSTER_ID = 'host:challenge-author';
const CAPABILITY = 'challenge-authoring';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  vi.mocked(listRoster).mockClear();
});

describe('ensureChallengeAuthor (ADR 0458 §2.1)', () => {
  it('provisions a fixed-identity author with the factory assigned + capability active', async () => {
    const author = await ensureChallengeAuthor(T);
    expect(author.rosterId).toBe(ROSTER_ID);
    expect(author.roleKey).toBe(ROLE);
    expect(author.workflows).toEqual(['openwop-app.kicktodo.challenge-factory']);
    // EXPLICIT heartbeat off + review autonomy — never inherit a running default.
    expect(author.heartbeatIntervalMs).toBe(-1);
    expect(author.autonomyLevel).toBe('review');

    const roster = await listRoster(T);
    const entry = roster.find((e) => e.roleKey === ROLE);
    expect(entry?.agentRef.agentId).toBe('vendor.openwop-app.kicktodo.agents.challenge-author');

    const profile = await getAgentProfile(T, ROSTER_ID);
    expect(profile?.capabilities).toContain(CAPABILITY);
  });

  it('single-flight: two calls in flight share ONE provisioning (the same result object)', async () => {
    const [a, b] = await Promise.all([ensureChallengeAuthor(T), ensureChallengeAuthor(T)]);
    expect(a).toBe(b); // one in-flight promise, not two converging sagas
    expect(a.rosterId).toBe(ROSTER_ID);
  });

  it('catch-converge: a create that loses to an existing author converges on it instead of failing', async () => {
    await ensureChallengeAuthor(T); // the "winner" row exists
    // Force the lost race: the saga's first role lookup misses the winner, so it
    // attempts a create that the deterministic id refuses (409) — the catch must
    // re-read and converge.
    vi.mocked(listRoster).mockResolvedValueOnce([]);
    const loser = await ensureChallengeAuthor(T);
    expect(vi.mocked(listRoster).mock.calls.length).toBeGreaterThanOrEqual(2); // the re-read ran
    expect(loser.rosterId).toBe(ROSTER_ID);
    expect(loser.autonomyLevel).toBe('review');
  });

  it('is idempotent: repeat calls yield ONE roster entry and ONE capability (heal is additive)', async () => {
    await Promise.all([ensureChallengeAuthor(T), ensureChallengeAuthor(T)]);
    await ensureChallengeAuthor(T); // a third, sequential — the capability heal path
    const authors = (await listRoster(T)).filter((e) => e.roleKey === ROLE);
    expect(authors).toHaveLength(1); // by construction (deterministic id + CAS)
    const profile = await getAgentProfile(T, ROSTER_ID);
    expect(profile?.capabilities?.filter((c) => c === CAPABILITY)).toHaveLength(1);
  });
});
