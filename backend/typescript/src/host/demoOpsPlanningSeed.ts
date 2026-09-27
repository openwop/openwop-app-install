/**
 * `demo-ops-planning` seeder (app-seeding-strategy.md §4 Phase 10, ADR 0031).
 *
 * The connective tissue + the exec demo, over the whole Solstice narrative:
 * strategies whose KRs bind to LIVE seeded metrics, projects with kanban boards,
 * priority-matrix lists, CSM accounts linked to the CRM, the Iris assistant graph
 * (stakeholders / commitments / decisions / meetings / pending actions), and a
 * Go-to-Market advisory board carrying a strategy as context.
 * `dependsOn: ['demo-crm','demo-commerce-depth','demo-people']`.
 *
 * Each toggle-gated sub-step skips honestly (strategy / priority-matrix /
 * advisory-board default ON; csm default OFF; projects + assistant are always-on
 * core). Several stores carry no `createdBy` field, so clear scopes by
 * deterministic markers (crmRef, source.externalId, calendarEventId prefixes,
 * name sets) via delete APIs or tenant-indexed direct handles — no orphans.
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { getUserByPrincipal } from '../features/users/usersService.js';
import { listRoster } from './rosterService.js';
import { createStrategy, listStrategies, hardDeleteStrategy } from '../features/strategy/strategyService.js';
import { appendCheckIn } from '../features/strategy/checkIns.js';
import { createProject, listProjects, updateProject, addProjectMember, deleteProject, projectSubject } from '../features/projects/projectsService.js';
import { subjectConversationId } from './conversationStore.js';
import { deleteConversationCompletely } from './conversationCascade.js';
import type { Storage } from '../storage/storage.js';
import { ensureSubjectBoard, createCard } from './kanbanService.js';
import { createList, submitIdea, setIdeaScore, createPlanningSession, listLists, deleteList } from '../features/priority-matrix/priorityMatrixService.js';
import { createAccount, listAccounts, deleteAccount, setAccountHealthForTenant } from '../features/csm/accountsService.js';
import {
  upsertStakeholder, upsertCommitmentBySource, projectCommitmentToBoard, logDecision, recordMeeting,
  enqueuePendingAction, listCommitments, deleteCommitment, contentHashOf,
  listStakeholders, listDecisions, listMeetings, listPendingActions,
  type PersonRef, type SourceRef,
} from '../features/assistant/assistantService.js';
import { createBoard as createAdvisoryBoard, listBoards as listAdvisoryBoards } from '../features/advisory-board/service.js';
import { SOLSTICE_COMPANIES, personPrincipal, demoCrmCompanyId, demoCrmContactId } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoOpsPlanning');
const ACTOR = 'demo:ops-planning';
const MARK = 'demo-ops-';

// Direct handles for the no-delete / owner-guarded stores (clear-time only).
const stakeholderStore = new DurableCollection<{ stakeholderId: string; tenantId: string; person?: PersonRef }>('assistant:stakeholder', (s) => s.stakeholderId, undefined, (s) => s.tenantId);
const decisionStore = new DurableCollection<{ decisionId: string; tenantId: string; source?: { externalId?: string } }>('assistant:decision', (d) => d.decisionId, undefined, (d) => d.tenantId);
const meetingStore = new DurableCollection<{ meetingId: string; tenantId: string; calendarEventId?: string }>('assistant:meeting', (m) => m.meetingId, undefined, (m) => m.tenantId);
const pendingActionStore = new DurableCollection<{ actionId: string; tenantId: string; payload?: Record<string, unknown> }>('assistant:pending-action', (a) => a.actionId, undefined, (a) => a.tenantId);
const advisoryStore = new DurableCollection<{ boardId: string; tenantId: string; createdBy?: string }>('advisory:board', (b) => `${b.tenantId}:${b.boardId}`, undefined, (b) => b.tenantId);

// CRM ids are tenant-scoped (solsticeDemo demoCrm*Id) — bound per call in seed.
const PROJECT_NAMES = ['Storefront Revamp', 'Wholesale Expansion Program', 'Subscription Growth', 'Q4 Holiday Campaign', 'Roastery Capacity'];

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}
async function gate(id: string, tenantId: string): Promise<boolean> {
  return Boolean((await resolveOne(id, { tenantId }))?.enabled);
}
function manualSource(externalId: string): SourceRef {
  return { kind: 'manual', externalId: `${MARK}${externalId}`, contentHash: contentHashOf(externalId), capturedAt: new Date().toISOString(), contentTrust: 'trusted' };
}

export async function countDemoOpsPlanning(tenantId: string): Promise<number> {
  return (await listStrategies(tenantId, { includeArchived: true })).filter((s) => s.createdBy === ACTOR).length;
}

export async function seedDemoOpsPlanning(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  const COMPANY_ID = (slug: string): string => demoCrmCompanyId(tenantId, slug);
  const CONTACT_ID = (slug: string, k: number): string => demoCrmContactId(tenantId, slug, k);
  const orgId = await orgIdFor(tenantId);
  const nowMs = Date.now();
  let created = 0;
  const skipped: string[] = [];

  // 1) Strategy — 2 strategies whose KRs bind to LIVE seeded metrics + check-ins.
  const strategyIds: string[] = [];
  if (await gate('strategy', tenantId)) {
    const existing = (await listStrategies(tenantId, { includeArchived: true })).filter((s) => s.createdBy === ACTOR);
    if (existing.length === 0) {
      const s1 = await createStrategy(tenantId, orgId, ACTOR, {
        scope: 'org', title: 'FY26 Growth', summary: 'Grow DTC + wholesale revenue and pipeline.', status: 'active', planningHorizon: 'annual',
        objectives: [{ title: 'Grow revenue', keyResults: [
          { title: 'Commerce revenue', measure: { kind: 'currency', target: 500000, direction: 'increase', unit: 'USD', source: { kind: 'commerce-revenue', orgId, query: 'USD' } } },
          { title: 'Deal pipeline total', measure: { kind: 'currency', target: 1000000, direction: 'increase', unit: 'USD', source: { kind: 'crm-deal-total', orgId } } },
        ] }],
      });
      const s2 = await createStrategy(tenantId, orgId, ACTOR, {
        scope: 'org', title: 'Wholesale Expansion', summary: 'Win new wholesale accounts across territories.', status: 'active', planningHorizon: 'annual',
        objectives: [{ title: 'Expand wholesale', keyResults: [
          { title: 'Storefront conversions', measure: { kind: 'numeric', target: 200, direction: 'increase', source: { kind: 'analytics-conversions', orgId } } },
        ] }],
      });
      strategyIds.push(s1.id, s2.id);
      created += 2;
      // 3 human check-ins across the KRs.
      const kr1 = s1.objectives[0]?.keyResults[0]?.id;
      const kr2 = s1.objectives[0]?.keyResults[1]?.id;
      const kr3 = s2.objectives[0]?.keyResults[0]?.id;
      if (kr1) await appendCheckIn({ strategy: s1, krId: kr1, value: 320000, note: 'On track — Q3 wholesale wins landing.', origin: 'human', actor: ACTOR });
      if (kr2) await appendCheckIn({ strategy: s1, krId: kr2, value: 780000, note: 'Pipeline building on the new-business deals.', origin: 'human', actor: ACTOR });
      if (kr3) await appendCheckIn({ strategy: s2, krId: kr3, value: 140, note: 'Conversions up after the campaign launch.', origin: 'human', actor: ACTOR });
    } else strategyIds.push(...existing.map((s) => s.id));
  } else skipped.push('strategy');

  // 2) Projects (5) with charters/milestones/members + 12 kanban cards each.
  const existingProjects = new Map((await listProjects(tenantId)).map((p) => [p.name, p]));
  const leadUserId = (await getUserByPrincipal(tenantId, personPrincipal('maya-solberg')))?.userId;
  for (const [pi, name] of PROJECT_NAMES.entries()) {
    if (existingProjects.has(name)) continue;
    const project = await createProject(tenantId, orgId, { name });
    await updateProject(tenantId, project.id, { charter: { goal: `Deliver ${name.toLowerCase()} for Solstice Roasters.`, status: 'active', health: pi % 3 === 0 ? 'at-risk' : 'on-track', milestones: [{ id: `m1`, title: 'Kickoff', done: true }, { id: 'm2', title: 'Build', done: false }, { id: 'm3', title: 'Launch', done: false }] } }).catch(() => undefined);
    if (leadUserId) await addProjectMember(tenantId, project.id, `user:${leadUserId}`, 'lead').catch(() => undefined);
    const board = await ensureSubjectBoard(tenantId, { kind: 'project', id: project.id }, `${name} board`);
    const cols = ['todo', 'doing', 'done'];
    for (let c = 0; c < 12; c += 1) {
      await createCard({ boardId: board.id, columnId: cols[c % 3]!, title: `${name}: task ${c + 1}`, createdBy: ACTOR, priority: c % 4 === 0 ? 'high' : 'normal' }).catch(() => undefined);
    }
    created += 1;
  }

  // 3) Priority-matrix — 2 lists, 12 scored ideas, 1 planning session.
  if (await gate('priority-matrix', tenantId)) {
    const existingLists = new Map((await listLists(tenantId)).filter((l) => l.createdBy === ACTOR).map((l) => [l.name, l]));
    const LISTS = [
      { name: 'Product Roadmap', ideas: ['Espresso subscription tier', 'Cold brew multipacks', 'Gift card program', 'Mobile app', 'Loyalty rewards', 'Same-day local delivery'] },
      { name: 'Retail Expansion Ideas', ideas: ['New East metros', 'Grocery endcaps', 'Hotel minibar program', 'Airport kiosks', 'Corporate gifting', 'Farmers markets'] },
    ];
    let firstListId: string | undefined;
    let firstCards: string[] = [];
    for (const l of LISTS) {
      if (existingLists.has(l.name)) continue;
      // R2 PM review — these scores used the ICE ids (`impact/effort/confidence`) against
      // a `weighted` preset, so every key was dropped by `setIdeaScore` and all twelve
      // seeded ideas rendered at priority 0. The drop is now a typed failure, which the
      // `.catch(() => undefined)` below would have swallowed just as quietly.
      const list = await createList(tenantId, orgId, ACTOR, { name: l.name, presetId: 'weighted' });
      firstListId ??= list.id;
      for (const [ii, title] of l.ideas.entries()) {
        const card = await submitIdea(tenantId, list.id, ACTOR, { title, description: `Idea: ${title}` });
        if (list.id === firstListId) firstCards.push(card.id);
        await setIdeaScore(tenantId, list.id, card.id, ACTOR, { 'strategic-alignment': 3 + (ii % 8), roi: 4 + (ii % 6), urgency: 2 + (ii % 7), 'compliance-risk': 1 + (ii % 5), cost: 2 + (ii % 6) }).catch(() => undefined);
      }
      created += 1;
    }
    if (firstListId && firstCards.length) {
      await createPlanningSession(tenantId, firstListId, ACTOR, { name: 'Q4 planning', selection: { mode: 'top-n', n: 4 } }).catch(() => undefined);
    }
  } else skipped.push('priority-matrix');

  // 4) CSM — 10 accounts crmRef-linked to the top demo companies, health spread.
  if (await gate('csm', tenantId)) {
    const existingRefs = new Set((await listAccounts(tenantId)).map((a) => a.crmRef?.companyId).filter(Boolean));
    for (const [ci, c] of SOLSTICE_COMPANIES.slice(0, 10).entries()) {
      if (existingRefs.has(COMPANY_ID(c.slug))) continue;
      const health = c.tier === 'enterprise' ? 82 : c.tier === 'mid-market' ? 58 : 33;
      // CRM-3 — first-class commercial depth (deterministic per index/tier; idempotent via existingRefs).
      const arr = (c.tier === 'enterprise' ? 250_000 : c.tier === 'mid-market' ? 60_000 : 12_000) + ci * 1_500;
      const renewalDate = `2027-${String((ci % 12) + 1).padStart(2, '0')}-15`;
      const owner = ci % 2 === 0 ? 'demo-user-cs-1' : 'demo-user-cs-2';
      const account = await createAccount({ tenantId, name: c.name, healthScore: health, crmRef: { orgId, companyId: COMPANY_ID(c.slug) }, arr, renewalDate, owner }).catch(() => null);
      if (account) {
        // R2 CS-SP-4 — factors MUST carry the score they computed (the service
        // now fails closed; this seed WAS the dishonest-stamp instance: its
        // factor-weighted score didn't match the created score). Compute it.
        const factors = [{ factor: 'Order recency', weight: 40, value: ci % 3 === 0 ? 30 : 80 }, { factor: 'Support volume', weight: 30, value: 70 }, { factor: 'Renewal proximity', weight: 30, value: 60 }];
        const weighted = Math.round(factors.reduce((acc, f) => acc + f.weight * f.value, 0) / factors.reduce((acc, f) => acc + f.weight, 0));
        // ADR 0582 §5 (CSM-UX-4) — this seed and `feature.csm.nodes.health-set`
        // emit the SAME `{factor, weight, value}` header shape from DIFFERENT
        // arithmetic (a weighted MEAN over 0–100 sub-scores here; `100 − Σ(w×count)`
        // there). Stating the method is what makes the breakdown readable instead
        // of self-contradictory. §4: a computed set must also name the company it
        // measured, which for a seeded row is the one it was just linked to.
        await setAccountHealthForTenant(tenantId, account.accountId, {
          healthScore: weighted,
          factors,
          method: 'weighted-mean',
          computedForCompanyId: COMPANY_ID(c.slug),
        }).catch(() => undefined);
        created += 1;
      }
    }
  } else skipped.push('csm');

  // 5) Assistant (Iris) — stakeholders, commitments, decisions, meetings, pending.
  {
    const contacts: PersonRef[] = SOLSTICE_COMPANIES.slice(0, 8).map((c) => ({ kind: 'crm-contact', orgId, contactId: CONTACT_ID(c.slug, 0) }));
    for (const [si, person] of contacts.entries()) {
      await upsertStakeholder(tenantId, { person, importance: 60 + (si % 4) * 10, intendedCadenceDays: 14 + (si % 3) * 14, lastMeaningfulContactAt: new Date(nowMs - (si % 20) * 86400_000).toISOString(), notes: 'Key account relationship.' }).catch(() => undefined);
    }
    const projectsForCommit = (await listProjects(tenantId)).filter((p) => PROJECT_NAMES.includes(p.name));
    for (let i = 0; i < 12; i += 1) {
      const r = await upsertCommitmentBySource(tenantId, { owner: { kind: 'self' }, description: `Follow up on ${PROJECT_NAMES[i % PROJECT_NAMES.length]} action ${i + 1}`, source: manualSource(`cmt-${i}`), dueAt: new Date(nowMs + (3 + i) * 86400_000).toISOString(), status: i % 4 === 0 ? 'in-progress' : 'open' }).catch(() => null);
      // Link ~4 commitments to a project kanban board (kanbanCardId).
      if (r?.commitment && i % 3 === 0 && projectsForCommit[i % projectsForCommit.length]) {
        const proj = projectsForCommit[i % projectsForCommit.length]!;
        const board = await ensureSubjectBoard(tenantId, { kind: 'project', id: proj.id });
        await projectCommitmentToBoard(tenantId, r.commitment.commitmentId, { boardId: board.id }).catch(() => undefined);
      }
    }
    for (let i = 0; i < 6; i += 1) {
      await logDecision(tenantId, { statement: `Approved: ${['Q4 holiday spend', 'Greenleaf expansion', 'New East territory hire', 'Subscription tier pricing', 'Roastery capacity plan', 'Wholesale price update'][i]}`, decidedBy: { kind: 'self' }, source: manualSource(`dec-${i}`), rationale: 'Reviewed with the leadership team.' }).catch(() => undefined);
    }
    for (let i = 0; i < 6; i += 1) {
      await recordMeeting(tenantId, { calendarEventId: `${MARK}mtg-${i}`, title: ['Weekly leadership sync', 'Pipeline review', 'Board prep', 'Wholesale QBR', 'Marketing planning', 'Ops review'][i]!, startAt: new Date(nowMs - (i * 2) * 86400_000).toISOString(), attendees: [{ kind: 'self' }] }).catch(() => undefined);
    }
    // 3 pending actions — the HITL queue (raw pending rows; surface in the
    // "waiting on me" list). Kinds spread across the action vocabulary.
    if ((await listPendingActions(tenantId)).filter((a) => (a.payload as { demo?: boolean })?.demo).length === 0) {
      const acts: { kind: 'email.send' | 'calendar.invite' | 'nudge'; draft: string }[] = [
        { kind: 'email.send', draft: 'Send the Harborview renewal summary to Dana Reyes.' },
        { kind: 'calendar.invite', draft: 'Invite the leadership team to the Q4 planning session.' },
        { kind: 'nudge', draft: 'Nudge Sofia on the Daily Grind multi-location proposal.' },
      ];
      for (const [ai, a] of acts.entries()) {
        await enqueuePendingAction(tenantId, { kind: a.kind, payload: { demo: true }, draft: a.draft, riskLevel: ai === 0 ? 'medium' : 'low', sourceRefs: [manualSource(`act-${ai}`)] }).catch(() => undefined);
      }
      created += 3;
    }
  }

  // 6) Advisory board — a Go-to-Market board carrying a strategy as context.
  if ((await gate('advisory-board', tenantId)) && strategyIds.length) {
    const advisors = (await listRoster(tenantId)).filter((r) => r.roleKey === 'advisor').map((r) => r.rosterId).slice(0, 3);
    // Idempotent by handle. The old guard read `listForTenantIndexed`, but the
    // advisory-board SERVICE writes through a collection instance with no tenant
    // index, so that marker is never set and the guard was always empty → a new
    // gtm-advisory board every run (createBoard auto-uniquifies → -2/-3/…). Read
    // the consistent primary scan instead, matching the other board seeders.
    const gtmExists = (await listAdvisoryBoards(tenantId, undefined)).some((b) => b.handle === 'gtm-advisory');
    if (advisors.length && !gtmExists) {
      await createAdvisoryBoard(tenantId, orgId, ACTOR, { name: 'Go-to-Market Advisory', handle: 'gtm-advisory', advisors, contextRefs: strategyIds.map((strategyId) => ({ kind: 'strategy' as const, strategyId })), visibility: 'shared', personaKind: 'original' }).then(() => { created += 1; }).catch((e) => log.warn('advisory_board_skipped', { error: e instanceof Error ? e.message : String(e) }));
    }
  } else if (!strategyIds.length) skipped.push('advisory-board (no strategy)');

  log.info('demo_ops_planning_seeded', { tenantId, created, skipped });
  return { created, details: { strategies: strategyIds.length, projects: PROJECT_NAMES.length, skipped } };
}

export async function clearDemoOpsPlanning(tenantId: string, storage: Storage): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  let cleared = 0;

  // Advisory board (owner-guarded delete → direct store; ids ARE tenant-prefixed
  // so listByPrefix reaches them without an index).
  for (const b of (await advisoryStore.listByPrefix(`${tenantId}:`)).filter((x) => x.createdBy === ACTOR)) { await advisoryStore.delete(`${tenantId}:${b.boardId}`); cleared += 1; }
  // Assistant graph — read via the tenant-scoped service lists, delete via the
  // store (only commitments expose a delete API; the rest are direct).
  for (const c of (await listCommitments(tenantId)).filter((x) => x.source?.externalId?.startsWith(MARK))) { if (await deleteCommitment(tenantId, c.commitmentId)) cleared += 1; }
  for (const d of (await listDecisions(tenantId)).filter((x) => x.source?.externalId?.startsWith(MARK))) { await decisionStore.delete(d.decisionId); cleared += 1; }
  for (const m of (await listMeetings(tenantId)).filter((x) => x.calendarEventId?.startsWith(MARK))) { await meetingStore.delete(m.meetingId); cleared += 1; }
  for (const s of (await listStakeholders(tenantId)).filter((x) => x.person?.kind === 'crm-contact' && x.person.contactId.startsWith('crm:demo-crm-'))) { await stakeholderStore.delete(s.stakeholderId); cleared += 1; }
  for (const a of (await listPendingActions(tenantId)).filter((x) => (x.payload as { demo?: boolean })?.demo)) { await pendingActionStore.delete(a.actionId); cleared += 1; }
  // CSM accounts (crmRef → demo companies).
  for (const a of (await listAccounts(tenantId)).filter((x) => x.crmRef?.companyId?.startsWith('cmp:demo-crm-'))) { if (await deleteAccount(a.accountId)) cleared += 1; }
  // Priority-matrix lists (delete cascades ideas/scores/sessions).
  for (const l of (await listLists(tenantId)).filter((x) => x.createdBy === ACTOR)) { if (await deleteList(tenantId, l.id, ACTOR)) cleared += 1; }
  // Projects (delete cascades board + cards). WF-PRJ-6b — the service-level
  // `deleteProject` cannot reach the project's group conversation (the full
  // cascade needs `storage`; a partial meta-only delete is the PRJ2-M1
  // inversion), so cascade it HERE first — a user who opened a chat on a demo
  // project must not orphan it on demo-clear.
  for (const p of (await listProjects(tenantId)).filter((x) => PROJECT_NAMES.includes(x.name))) {
    await deleteConversationCompletely(storage, tenantId, subjectConversationId(tenantId, projectSubject(p.id)));
    const r = await deleteProject(tenantId, p.id); if (r.deleted) cleared += 1;
  }
  // Strategies (cascades revisions + check-ins).
  for (const s of (await listStrategies(tenantId, { includeArchived: true })).filter((x) => x.createdBy === ACTOR)) { if (await hardDeleteStrategy(tenantId, s.id)) cleared += 1; }

  log.info('demo_ops_planning_cleared', { tenantId, cleared });
  return { cleared };
}
