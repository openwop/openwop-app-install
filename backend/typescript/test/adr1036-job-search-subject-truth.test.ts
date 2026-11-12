/**
 * ADR 1036 — job search acts for ONE person, and its authority objects are that
 * person's own.
 *
 * Each block witnesses a door the row-81 grade found open on `0a3da6141`:
 *
 *  - D1  a campaign pass ran EVERY member's grants and reported their grant and
 *        campaign ids; it now resolves one person from the RUN (the starter, or
 *        the member a feature-owned queue row names) and refuses a run that names
 *        nobody — including a card whose body-writable `createdBy` names someone;
 *  - D1b queuing found a colleague's card and grant;
 *  - D3  two members applying to one listing shared ONE deal;
 *  - D4  the unit was spent AFTER the send, its result dropped, so two passes on
 *        a one-unit grant both sent; a refused send is refunded and not attestable;
 *  - D5  any member listed and revoked every attestation, and revoked any grant;
 *  - D6  erasure left the person's application deals.
 *
 * Sabotage-witnessed (row 81): see the per-run record
 * `docs/steward/workflows-assessment/2026-11-03-job-search-row81.md`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetHostExtPersistence, initHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createUser } from '../src/features/users/usersService.js';
import { createApplyGrant, applyGrants, consumeSubmit, refundSubmit, revokeApplyGrant, recordSubmissionRejected } from '../src/host/applyGrant.js';
import { createCard } from '../src/host/kanbanService.js';
import { buildJobSearchSurface } from '../src/features/job-search/surface.js';
import { queueCampaignCard, CAREER_CAMPAIGN_CARD_WORKFLOW_ID, provisionCareerAgent, CAREER_DESCRIPTION } from '../src/features/job-search/agent/provision.js';
import { listRoster, updateRosterEntry } from '../src/host/rosterService.js';
import { runTenantCampaignPass } from '../src/features/job-search/autopilot/campaignRun.js';
import { putSteering, getSteering } from '../src/features/job-search/agent/steering.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { registerBoardAdapter, getBoardAdapter, type BoardAdapter } from '../src/features/job-search/boards/adapters.js';
import { upsertListing } from '../src/features/job-search/boards/listing.js';
import { createApplication, eraseSubjectApplications, subjectDealTag, isForeignApplicationId } from '../src/features/job-search/domain/applications.js';
import { jobDigests } from '../src/features/job-search/domain/digest.js';
import { registerJobSearchCrmCascade } from '../src/features/job-search/lifecycle/crmCascade.js';
import { issueAttestation, listAttestations, revokeAttestation } from '../src/features/job-search/attestation/token.js';
import { findAttestableApplication, buildClaimSet } from '../src/features/job-search/attestation/claims.js';
import { listDeals, createPipeline, createDeal } from '../src/features/crm/crmEntitiesService.js';

const T = 'org:t-adr1036';
const A = 'user:alice';
const B = 'user:bob';
const NOW = 7_200_000_000; // an exact hour boundary

const SUBMITS = new Map<string, string[]>([['adr1036-ok', []], ['adr1036-rej', []], ['adr1036-slow', []]]);

function board(id: string, submit: (listingId: string) => Promise<{ ok: boolean }>): BoardAdapter {
  return {
    id, displayName: id, origin: `${id}.example.com`, auth: { kind: 'public' }, tier: 'A',
    searchUrlTemplate: 'https://{company}.example.com', postingsPath: 'jobs', map: { title: 'title' },
    docsUrl: 'https://example.com/docs',
    submitLane: {
      async fetchQuestions() { return []; },
      async submit(prepared) { return submit(prepared.listingId); },
    },
  };
}

beforeAll(() => {
  registerJobSearchCrmCascade(); // feature.ts wires it at boot; this file runs no boot
  const log = (id: string) => SUBMITS.get(id)!;
  if (!getBoardAdapter('adr1036-ok')) registerBoardAdapter(board('adr1036-ok', async (l) => { log('adr1036-ok').push(l); return { ok: true }; }));
  if (!getBoardAdapter('adr1036-rej')) registerBoardAdapter(board('adr1036-rej', async (l) => { log('adr1036-rej').push(l); return { ok: false }; }));
  // Slow: the send takes real time, so a second pass can interleave with it.
  if (!getBoardAdapter('adr1036-slow')) {
    registerBoardAdapter(board('adr1036-slow', async (l) => {
      log('adr1036-slow').push(l);
      await new Promise((r) => setTimeout(r, 40));
      return { ok: true };
    }));
  }
});

let ORG = '';
beforeEach(async () => {
  for (const l of SUBMITS.values()) l.length = 0;
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(':memory:'));
  ORG = (await createOrg({ tenantId: T, createdBy: A, name: 'Search' })).orgId;
});

const ORIGINS = ['adr1036-ok.example.com', 'adr1036-rej.example.com', 'adr1036-slow.example.com'];
const grantFor = (subjectId: string, over: Partial<Parameters<typeof createApplyGrant>[0]> = {}) =>
  createApplyGrant({
    tenantId: T, orgId: ORG, subjectId, grantedBy: subjectId, campaignId: `camp-${subjectId}`,
    maxSubmits: 10, maxPrepared: 5, ratePerHour: 10, origins: ORIGINS,
    resumePolicy: 'default', expiresAt: '2999-01-01T00:00:00.000Z', ...over, // the surface passes the real clock
  });
const steerFor = (subjectId: string) =>
  putSteering(T, { policy: { roles: ['Staff Backend Engineer'], minMatchScore: 1, dailyCap: 10, ratePerHour: 10, tiers: ['A'] } }, subjectId);
const listing = (boardId: string, n: number) =>
  upsertListing(T, A, {
    title: 'Staff Backend Engineer', companyName: `Co ${boardId}-${n}`, location: 'Remote', sourceBoard: boardId,
    sourceUrl: `https://${boardId}.example.com/jobs/${n}`,
    ext: { skills: [], requirements: [], responsibilities: [], descriptionExcerpt: 'Build things.' },
  });

async function insertRun(runId: string, metadata: Record<string, unknown>, parentRunId?: string): Promise<void> {
  const at = new Date(NOW).toISOString();
  await hostExtStorage().insertRun({
    runId, workflowId: CAREER_CAMPAIGN_CARD_WORKFLOW_ID, tenantId: T, status: 'running',
    inputs: null, metadata, configurable: {}, createdAt: at, updatedAt: at,
    ...(parentRunId ? { parentRunId, forkMode: 'replay' as const } : {}),
  });
}

describe('ADR 1036 D1 — a pass acts for exactly one person, resolved from the run', () => {
  it('a member who starts the run runs ONLY their own grants, and the report carries no ids', async () => {
    await steerFor(A); await steerFor(B);
    await grantFor(A); await grantFor(B);
    await listing('adr1036-ok', 1);
    const out = await buildJobSearchSurface({ tenantId: T, runId: 'run-direct', actingUserId: B }).runCampaignPass!({});
    expect(out).toMatchObject({ ranGrants: 1, applied: 1 });
    const grants = await applyGrants.listByPrefix(`${T}:`);
    expect(grants.find((g) => g.subjectId === A)!.submitsUsed, "Alice's grant must not move on Bob's run").toBe(0);
    expect(grants.find((g) => g.subjectId === B)!.submitsUsed).toBe(1);
    // Counts only: run output is workspace-readable.
    const text = JSON.stringify(out);
    for (const leak of ['grant', 'camp-', 'results', 'listingId']) expect(text).not.toContain(leak);
  });

  it('a run carrying the LEGACY principal spelling acts for the canonical user (two-spellings class)', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:legacy-alice' });
    await steerFor(u.userId);
    await grantFor(u.userId);
    await listing('adr1036-ok', 1);
    const out = await buildJobSearchSurface({ tenantId: T, runId: 'run-legacy', actingUserId: 'oidc:legacy-alice' }).runCampaignPass!({});
    expect(out, 'raw equality would have matched no grant').toMatchObject({ ranGrants: 1, applied: 1 });
  });

  it('a HEARTBEAT run resolves the member who queued the card, through the feature-owned row', async () => {
    await steerFor(A); await grantFor(A); await grantFor(B);
    await listing('adr1036-ok', 1);
    const { card } = await queueCampaignCard(T, A, NOW);
    await insertRun('run-hb', { heartbeat: { cardId: card.id, source: 'heartbeat' } });
    const out = await buildJobSearchSurface({ tenantId: T, runId: 'run-hb' }).runCampaignPass!({});
    expect(out).toMatchObject({ ranGrants: 1 });
    const grants = await applyGrants.listByPrefix(`${T}:`);
    expect(grants.find((g) => g.subjectId === A)!.submitsUsed).toBe(1);
    expect(grants.find((g) => g.subjectId === B)!.submitsUsed).toBe(0);
  });

  it('an APPROVED run acts for the queuer — never for the approver (orgScopeSubject)', async () => {
    await steerFor(A); await grantFor(A); await grantFor(B);
    await listing('adr1036-ok', 1);
    const { card } = await queueCampaignCard(T, A, NOW);
    await insertRun('run-ap', { approval: { cardId: card.id, source: 'approval' } });
    await buildJobSearchSurface({ tenantId: T, runId: 'run-ap', orgScopeSubject: B }).runCampaignPass!({});
    const grants = await applyGrants.listByPrefix(`${T}:`);
    expect(grants.find((g) => g.subjectId === A)!.submitsUsed).toBe(1);
    expect(grants.find((g) => g.subjectId === B)!.submitsUsed, 'the approver is not the job seeker').toBe(0);
  });

  it('a card whose body-writable createdBy names a colleague resolves to NOBODY — typed refusal', async () => {
    await grantFor(A);
    const { boardId } = await provisionCareerAgent(T);
    // The generic kanban route copies `createdBy` from the request body; this is
    // what a board writer can file without ever calling queue-campaign.
    const forged = await createCard({ boardId, columnId: 'todo', title: 'x', workflowId: CAREER_CAMPAIGN_CARD_WORKFLOW_ID, source: 'api', createdBy: A });
    await insertRun('run-forged', { heartbeat: { cardId: forged.id } });
    await expect(buildJobSearchSurface({ tenantId: T, runId: 'run-forged' }).runCampaignPass!({}))
      .rejects.toMatchObject({ code: 'forbidden_scope', details: { reason: 'no_campaign_subject' } });
    expect((await applyGrants.listByPrefix(`${T}:`))[0]!.submitsUsed).toBe(0);
  });

  it('a run with no person and no card refuses, rather than reporting an empty success', async () => {
    await insertRun('run-bare', {});
    await expect(buildJobSearchSurface({ tenantId: T, runId: 'run-bare' }).runCampaignPass!({}))
      .rejects.toMatchObject({ details: { reason: 'no_campaign_subject' } });
  });

  it('a FORK resolves through its parent to the same person', async () => {
    await steerFor(A); await grantFor(A);
    const { card } = await queueCampaignCard(T, A, NOW);
    await insertRun('run-root', { heartbeat: { cardId: card.id } });
    await insertRun('run-fork', {}, 'run-root');
    const out = await buildJobSearchSurface({ tenantId: T, runId: 'run-fork' }).runCampaignPass!({});
    expect(out).toMatchObject({ ranGrants: 1 });
  });
});

describe('ADR 1036 D1b — queuing is per person', () => {
  it("a colleague's live grant is no precondition for my queue, and their card is not mine", async () => {
    await grantFor(A);
    await expect(queueCampaignCard(T, B, NOW)).rejects.toMatchObject({ details: { reason: 'no_active_grant' } });
    await grantFor(B);
    const a = await queueCampaignCard(T, A, NOW);
    const b = await queueCampaignCard(T, B, NOW);
    expect(b.created, "Bob's queue must not return Alice's waiting card").toBe(true);
    expect(b.card.id).not.toBe(a.card.id);
    expect((await queueCampaignCard(T, B, NOW)).card.id, 'idempotent per person').toBe(b.card.id);
  });
});

describe('ADR 1036 D3 — application deals are per person', () => {
  it('two members applying to one listing are two deals; a colleague cannot claim mine', async () => {
    await steerFor(A); await steerFor(B);
    await grantFor(A); await grantFor(B);
    const l = await listing('adr1036-ok', 1);
    await runTenantCampaignPass(T, A, NOW);
    await runTenantCampaignPass(T, B, NOW);
    const ids = (await listDeals(T, ORG, {})).map((d) => d.dealId).sort();
    expect(ids).toEqual([`deal:${subjectDealTag(A)}:${l.listingId}`, `deal:${subjectDealTag(B)}:${l.listingId}`].sort());
    const stolen = await createApplication({
      tenantId: T, orgId: ORG, actor: B, dealId: `deal:${subjectDealTag(A)}:${l.listingId}`,
      digest: { title: 'x', companyName: 'y', location: null, remote: null, skills: [], requirements: [], responsibilities: [], descriptionExcerpt: '', employmentType: 'unknown', sponsorship: 'silent', citizenshipRequirementQuote: null, clearanceRequirementQuote: null, sponsorshipQuote: null, salaryMin: null, salaryMax: null, currency: null, sourceUrl: null, capturedAt: '' },
      profile: { skills: [], targetTitles: [], salaryFloor: null, wantsRemote: null },
      applicant: { requiresSponsorship: false, meetsCitizenshipRequirement: true, holdsRequiredClearance: true },
    });
    expect(stolen.notYours).toBe(true);
    expect(stolen.deal, "a colleague's application is never echoed back").toBeNull();
  });
});

describe('ADR 1036 D4 — the unit is spent before the send', () => {
  it('two concurrent passes on a ONE-unit grant send exactly one application', async () => {
    await steerFor(A);
    await grantFor(A, { maxSubmits: 1 });
    await listing('adr1036-slow', 1);
    await listing('adr1036-slow', 2);
    await Promise.all([runTenantCampaignPass(T, A, NOW), runTenantCampaignPass(T, A, NOW)]);
    expect(SUBMITS.get('adr1036-slow')!.length, 'the ceiling is a true ceiling').toBe(1);
    expect((await applyGrants.listByPrefix(`${T}:`))[0]!.submitsUsed).toBe(1);
  });

  it('a board that refuses gets the unit back, and the refused deal is NOT attestable', async () => {
    await steerFor(A);
    await grantFor(A);
    const l = await listing('adr1036-rej', 1);
    await runTenantCampaignPass(T, A, NOW);
    const g = (await applyGrants.listByPrefix(`${T}:`))[0]!;
    expect(g.submitsUsed).toBe(0);
    expect(g.paceUsed ?? 0).toBe(0);
    const dealId = `deal:${subjectDealTag(A)}:${l.listingId}`;
    expect(await findAttestableApplication(T, dealId), 'nothing reached an employer').toBeNull();
    expect((await buildClaimSet(T, g.campaignId, NOW)).claims.some((c) => c.type === 'applications-in-window')).toBe(false);
  });

  it('a refused send leaves NO deal in "Applied" — the minted deal is withdrawn', async () => {
    await steerFor(A);
    await grantFor(A);
    await listing('adr1036-rej', 1);
    await runTenantCampaignPass(T, A, NOW);
    expect(await listDeals(T, ORG, {}), 'an application nobody received must not be listed').toEqual([]);
  });

  it('the rejection is recorded BEFORE the refund: a refund that never lands still cannot make it attestable', async () => {
    const g = await grantFor(A);
    await consumeSubmit(T, g.grantId, NOW, 'deal:r1');
    await recordSubmissionRejected(T, g.grantId, 'deal:r1');
    // No refund at all (lost races, crash): the consumption must still be void.
    expect(await findAttestableApplication(T, 'deal:r1')).toBeNull();
    // …and a LATER genuine send of the same pair counts again.
    await consumeSubmit(T, g.grantId, NOW, 'deal:r1');
    expect(await findAttestableApplication(T, 'deal:r1')).not.toBeNull();
  });

  it("a refund after the hour rolled returns the unit but not a LATER hour's pace slot", async () => {
    const g = await grantFor(A);
    expect(await consumeSubmit(T, g.grantId, NOW, 'deal:x')).toBe(true);
    const nextHour = NOW + 3_600_000;
    expect(await consumeSubmit(T, g.grantId, nextHour, 'deal:y')).toBe(true);
    // Refund the FIRST consumption, made in the previous hour.
    expect(await refundSubmit(T, g.grantId, 'deal:x', NOW)).toBe(true);
    const after = (await applyGrants.get(`${T}:${g.grantId}`))!;
    expect(after.submitsUsed).toBe(1);
    expect(after.paceUsed, 'this hour used one slot and still has used one').toBe(1);
  });
});

describe('ADR 1036 D3 — a colleague cannot squat my application id', () => {
  it('the per-person id shape is foreign to anyone it does not name', () => {
    const mine = `deal:${subjectDealTag(A)}:listing-1`;
    expect(isForeignApplicationId(mine, A)).toBe(false);
    expect(isForeignApplicationId(mine, B)).toBe(true);
    expect(isForeignApplicationId('deal:hand-entered-1', B), 'a free-form manual id is nobody\'s tag').toBe(false);
  });
});

describe('ADR 1036 D7 — a legacy tenant steering row', () => {
  const raw = new DurableCollection<{ tenantId: string; goals: string; policy: Record<string, unknown>; updatedBy: string; updatedAt: string }>(
    'job-search:steering', (r) => r.tenantId, undefined, (r) => r.tenantId);
  it('is adopted by its last author only; a colleague reads defaults, not its policy', async () => {
    await raw.put({ tenantId: T, goals: 'legacy prose', policy: { roles: ['Platform'], locations: [], remote: null, minMatchScore: 8, dailyCap: 2, ratePerHour: 1, tiers: ['A'] }, updatedBy: A, updatedAt: new Date(NOW).toISOString() });
    expect((await getSteering(T, B)).policy.minMatchScore, 'never served to someone else').toBe(5);
    const adopted = await getSteering(T, A);
    expect(adopted.policy.minMatchScore, 'a tightened policy must not silently loosen').toBe(8);
    expect(adopted.goals).toBe('legacy prose');
    expect(await raw.get(T), 'adopted, then gone').toBeNull();
  });
});

describe('ADR 1036 D9 — an existing career agent stops overclaiming', () => {
  it('replaces the exact pre-D9 description, and leaves an edited one alone', async () => {
    const first = await provisionCareerAgent(T);
    const entry = (await listRoster(T)).find((r) => r.rosterId === first.rosterId)!;
    await updateRosterEntry(T, entry.rosterId, { description: 'Finds roles, scores fit, and prepares applications within the limits you set.' });
    await provisionCareerAgent(T);
    expect((await listRoster(T)).find((r) => r.rosterId === entry.rosterId)!.description).toBe(CAREER_DESCRIPTION);
    await updateRosterEntry(T, entry.rosterId, { description: 'My own words' });
    await provisionCareerAgent(T);
    expect((await listRoster(T)).find((r) => r.rosterId === entry.rosterId)!.description).toBe('My own words');
  });
});

describe('ADR 1036 D5 — attestations and grants are the person’s own', () => {
  it('a colleague neither lists nor revokes my attestation, nor revokes my grant', async () => {
    const g = await grantFor(A);
    await consumeSubmit(T, g.grantId, NOW, 'deal:a1');
    const issued = await issueAttestation({ tenantId: T, dealId: 'deal:a1', issuedBy: A, now: NOW });
    if ('refused' in issued) throw new Error(issued.refused);
    expect(await listAttestations(T, B)).toEqual([]);
    expect(await revokeAttestation(T, issued.attestationId, NOW, B)).toBe(false);
    expect((await listAttestations(T, A)).map((r) => r.attestationId)).toEqual([issued.attestationId]);
    expect(await revokeApplyGrant(T, ORG, g.grantId, NOW, B), "a peer must not withdraw my grant").toBe(false);
    expect(await revokeAttestation(T, issued.attestationId, NOW, A)).toBe(true);
    expect(await revokeApplyGrant(T, ORG, g.grantId, NOW, A)).toBe(true);
  });
});

describe('ADR 1036 D6 — erasure removes the person’s applications, and only theirs', () => {
  it("deletes the deals the subject created in the application pipeline, with their digests; keeps a colleague's and other pipelines'", async () => {
    await steerFor(A); await steerFor(B);
    await grantFor(A); await grantFor(B);
    const l = await listing('adr1036-ok', 1);
    await runTenantCampaignPass(T, A, NOW);
    await runTenantCampaignPass(T, B, NOW);
    const sales = await createPipeline(T, ORG, 'Sales', [{ name: 'Lead' }]);
    await createDeal({ tenantId: T, orgId: ORG, dealId: 'deal:sales-1', title: 'Alice sells', pipelineId: sales.pipelineId, owner: A, createdBy: A, validateCompany: async () => true, validateContact: async () => true });

    await eraseSubjectApplications(T, A);

    const left = (await listDeals(T, ORG, {})).map((d) => d.dealId).sort();
    expect(left).toEqual(['deal:sales-1', `deal:${subjectDealTag(B)}:${l.listingId}`].sort());
    expect(await jobDigests.get(`${T}:deal:${subjectDealTag(A)}:${l.listingId}:1`), 'the cascade removed the digest').toBeNull();
  });
});
