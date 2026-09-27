/**
 * `demo-crm` seeder (app-seeding-strategy.md §4 Phase 3, ADR 0191 CRM).
 *
 * The B2B anchor: 15 companies, 75+ contacts (with CDP identifiers + one
 * reversible merge), 4 probability-weighted pipelines, 30 deals, ~60 activities,
 * 25 tasks, 6 overlapping segments, 4 custom-field defs, and ~13 weeks of
 * backdated pipeline snapshots. This is what makes CRM reports, quota attainment
 * (Phase 6), CDP identity/segments (Phase 7), and strategy KRs (Phase 10)
 * non-empty. `dependsOn: ['demo-people']` — owners resolve to the seeded reps.
 *
 * Mechanics (app-seeding-strategy.md §2 / §5):
 * - Real services (contacts/companies/deals/pipelines/activities/tasks/segments/
 *   fielddefs/identity/merge). Deterministic slug-derived ids → idempotent seed,
 *   surgical clear. Backdating: activities via their `createdAt` param; weekly
 *   snapshots via `upsertCrmSnapshot` with hand-built rows (the supported path).
 * - No toggle flips (CRM defaults on). Timestamps are relative to seed time.
 * - Clear also removes rows for stores with no delete API (activities, stage
 *   history the deals emit, snapshots) so seeding never strands orphans
 *   (data-gaps DG-INT-2).
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { getUserByPrincipal } from '../features/users/usersService.js';
import {
  createContact, listContacts, deleteContact, getContact,
} from '../features/crm/contactsService.js';
import {
  createCompany, listCompanies, deleteCompany,
  createPipeline, listPipelines, deletePipeline,
  createDeal, listDeals, deleteDeal,
  createActivity, createTask, listTasks, deleteTask,
  createFieldDef, createContactFieldDef, listFieldDefs, listContactFieldDefs, deleteFieldDef, deleteContactFieldDef,
  makeLinkValidators,
} from '../features/crm/crmEntitiesService.js';
import { createSegment, listSegments, deleteSegment } from '../features/crm/segmentsService.js';
import type { ContactIdentifier } from '../features/crm/contactIdentityService.js';
import { mergeContacts } from '../features/crm/crmMergeService.js';
import { upsertCrmSnapshot, crmSnapshotId, type CrmSnapshot, type StageSnapshotEntry } from '../features/crm/entities/snapshots.js';
import { isoWeek } from '../features/crm/snapshotDaemon.js';
import {
  SOLSTICE_COMPANIES, SOLSTICE_PIPELINES, SOLSTICE_DEALS, SOLSTICE_SEGMENTS,
  SOLSTICE_FIELD_DEFS, DEMO_CRM_ACTOR, crmContactName, personPrincipal,
  demoCrmCompanyId, demoCrmContactId, demoCrmDealId, demoCrmSegmentId, demoCrmTid,
  type SolsticeCompany,
} from './seed-data/solsticeDemo.js';

/** ADR 0627 D2 — the seed is a BULK lane: ~90 contacts, deals, tasks and
 *  activities must not fan out ~90 lifecycle host events to webhooks + bindings
 *  (and neither must the teardown). Attributed to the seed actor, silent. */
const SEED_EMIT = { actor: DEMO_CRM_ACTOR, silent: true } as const;

const log = createLogger('seed.demoCrm');

// Direct handles for stores with no per-row delete API (clear-time only).
const activityStore = new DurableCollection<{ activityId: string; tenantId: string; createdBy?: string }>('crm:activity', (a) => a.activityId, undefined, (a) => a.tenantId);
const stageHistoryStore = new DurableCollection<{ historyId: string; tenantId: string; actor?: string }>('crm:stagehistory', (r) => r.historyId, undefined, (r) => r.tenantId);
const snapshotStore = new DurableCollection<{ snapshotId: string; tenantId: string; pipelineId: string }>('crm:snapshot', (s) => s.snapshotId, undefined, (s) => s.tenantId);
const mergeEventStore = new DurableCollection<{ mergeEventId: string; tenantId: string; actor?: string }>('crm:merge-event', (e) => e.mergeEventId, undefined, (e) => e.tenantId);

// Tenant-scoped id closures — see solsticeDemo.ts demoCrm*Id. Bound per call.

const CONTACTS_PER_COMPANY = 5;

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

/** True only when a pipeline's name AND full stage shape (ordered name+
 *  probability) match a canonical demo pipeline — the ownership signal used by
 *  clear() so it never deletes a user's like-named pipeline (review #1356). */
function isDemoPipeline(p: { name: string; stages: { name: string; probability: number }[] }): boolean {
  const canon = SOLSTICE_PIPELINES.find((s) => s.name === p.name);
  if (!canon || canon.stages.length !== p.stages.length) return false;
  return canon.stages.every((cs, i) => p.stages[i]?.name === cs.name && p.stages[i]?.probability === cs.probability);
}

const ident = (type: ContactIdentifier['type'], value: string): ContactIdentifier => ({ type, value, source: 'seed' });

/** now − N days as strict YYYY-MM-DD. */
function ymd(nowMs: number, offsetDays: number): string {
  return new Date(nowMs + offsetDays * 86400_000).toISOString().slice(0, 10);
}

/** The owning rep for a company (aligns with the Phase-6 territory carve). */
function ownerRepSlug(c: SolsticeCompany): string {
  if (c.region === 'West') return c.tier === 'enterprise' ? 'dana-reyes' : 'priya-nair';
  return c.tier === 'enterprise' ? 'tomas-okafor' : 'sofia-lindqvist';
}

const STAGE_BY_SLOT: readonly ('customer' | 'qualified' | 'lead')[] = ['customer', 'qualified', 'lead', 'customer', 'lead'];
/** Companies whose 5th contact is churned (feeds the Churn-risk segment). */
const CHURNED_COMPANIES = new Set(['summit-lodges', 'fika-house', 'meadowlark-foods']);

export async function countDemoCrm(tenantId: string): Promise<number> {
  return (await listContacts(tenantId)).filter((c) => c.contactId.startsWith('crm:demo-crm-')).length;
}

export async function seedDemoCrm(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  // Toggle-gated: skip honestly when CRM is off (never flip the toggle).
  if (!(await resolveOne('crm', { tenantId }))?.enabled) {
    return { created: 0, details: { skipped: 'crm feature is off' } };
  }
  const orgId = await orgIdFor(tenantId);
  const nowMs = Date.now();
  let created = 0;
  const CONTACT_ID = (companySlug: string, k: number | string): string => demoCrmContactId(tenantId, companySlug, k);
  const COMPANY_ID = (slug: string): string => demoCrmCompanyId(tenantId, slug);
  const DEAL_ID = (slug: string): string => demoCrmDealId(tenantId, slug);
  const TID = demoCrmTid(tenantId); // activities/tasks have no slug-id helper; scope inline

  // Resolve the seeded reps to their user subjects (owners). Fall back to a
  // synthetic subject if demo-people wasn't seeded (keeps the seeder standalone).
  const repSubject = new Map<string, string>();
  for (const slug of ['dana-reyes', 'priya-nair', 'tomas-okafor', 'sofia-lindqvist']) {
    const u = await getUserByPrincipal(tenantId, personPrincipal(slug));
    repSubject.set(slug, u?.userId ?? `${DEMO_CRM_ACTOR}:${slug}`);
  }
  const subjectOf = (slug: string): string => repSubject.get(slug) ?? `${DEMO_CRM_ACTOR}:${slug}`;

  // 1) Custom field defs (idempotent by key).
  const existingDealDefs = new Set((await listFieldDefs(tenantId, orgId, 'deal')).map((d) => d.key));
  const existingContactDefs = new Set((await listContactFieldDefs(tenantId)).map((d) => d.key));
  for (const def of SOLSTICE_FIELD_DEFS) {
    if (def.entity === 'deal') {
      if (existingDealDefs.has(def.key)) continue;
      await createFieldDef({ tenantId, orgId, entityType: 'deal', key: def.key, label: def.label, type: def.type, options: def.options, ...SEED_EMIT });
    } else {
      if (existingContactDefs.has(def.key)) continue;
      await createContactFieldDef({ tenantId, key: def.key, label: def.label, type: def.type, options: def.options, ...SEED_EMIT });
    }
    created += 1;
  }

  // 2) Companies (idempotent by deterministic id).
  const existingCompanyIds = new Set((await listCompanies(tenantId, orgId)).map((c) => c.companyId));
  for (const c of SOLSTICE_COMPANIES) {
    if (existingCompanyIds.has(COMPANY_ID(c.slug))) continue;
    await createCompany({
      tenantId, orgId, companyId: COMPANY_ID(c.slug), createdBy: DEMO_CRM_ACTOR,
      name: c.name, domain: c.domain, industry: c.industry, tags: c.tags,
      size: c.employees, // CRM-2 (ADR 0383) — first-class firmographic (was customFields.employees)
      customFields: { region: c.region, tier: c.tier, hqCity: c.hqCity },
      ...SEED_EMIT,
    });
    created += 1;
  }

  // 3) Contacts (idempotent by deterministic id). ~20 get rich CDP identifiers.
  const existingContactIds = new Set((await listContacts(tenantId)).map((c) => c.contactId));
  let gi = 0;
  let identifiersGiven = 0;
  for (const c of SOLSTICE_COMPANIES) {
    const owner = subjectOf(ownerRepSlug(c));
    for (let k = 0; k < CONTACTS_PER_COMPANY; k += 1) {
      const id = CONTACT_ID(c.slug, k);
      const name = crmContactName(gi);
      const emailLocal = name.toLowerCase().replace(/[^a-z]+/g, '.');
      const stage = k === 4 && CHURNED_COMPANIES.has(c.slug) ? 'churned' : STAGE_BY_SLOT[k]!;
      gi += 1;
      if (existingContactIds.has(id)) continue;
      const identifiers: ContactIdentifier[] | undefined = stage === 'customer' && identifiersGiven < 20
        ? (identifiersGiven += 1, [
            ident('email', `${emailLocal}@${c.domain}`),
            ident('phone', `+1206555${String(1000 + gi).slice(-4)}`),
            ident('loyalty', `LOY-${c.slug}-${k}`),
            ident('external', `shopify:${9000 + gi}`),
            ident('device', `dev-${c.slug}-${k}`),
          ])
        : undefined;
      // CRM-2 (ADR 0383) — first-class title/leadSource (deterministic per index).
      const DEMO_TITLES = ['VP Sales', 'Head of Ops', 'Procurement Lead', 'Founder', 'Marketing Director', 'Buyer'];
      const DEMO_LEAD_SOURCES = ['Webinar', 'Referral', 'Trade show', 'Inbound', 'Partner', 'Cold outreach'];
      await createContact({
        tenantId, contactId: id, name, email: `${emailLocal}@${c.domain}`,
        company: c.name, stage, owner,
        title: DEMO_TITLES[gi % DEMO_TITLES.length],
        leadSource: DEMO_LEAD_SOURCES[gi % DEMO_LEAD_SOURCES.length],
        customFields: { industry: c.industry, region: c.region, tier: c.tier },
        ...(identifiers ? { identifiers } : {}),
        ...SEED_EMIT,
      });
      created += 1;
    }
  }

  // 3b) CDP-B — two near-duplicate pairs; merge ONE (shared-identifier) so a
  //     reversible crm:merge-event exists, and leave one (typo'd email) for
  //     matchCandidatesService to propose.
  const dupA1 = CONTACT_ID('dup', 'a1'), dupA2 = CONTACT_ID('dup', 'a2');
  const dupB1 = CONTACT_ID('dup', 'b1'), dupB2 = CONTACT_ID('dup', 'b2');
  if (!existingContactIds.has(dupA1)) {
    await createContact({ tenantId, contactId: dupA1, name: 'Renata Silva', email: 'renata.silva@harvestgrocers.com', company: 'Harvest Grocers', stage: 'qualified', owner: subjectOf('tomas-okafor'), customFields: { industry: 'Grocery', region: 'East', tier: 'enterprise' }, ...SEED_EMIT });
    await createContact({ tenantId, contactId: dupA2, name: 'Renata Silva', email: 'renata.silvia@harvestgrocers.com', company: 'Harvest Grocers', stage: 'lead', owner: subjectOf('tomas-okafor'), customFields: { industry: 'Grocery', region: 'East', tier: 'enterprise' }, ...SEED_EMIT });
    created += 2;
  }
  if (!existingContactIds.has(dupB1) && !(await getContact(dupB2))) {
    await createContact({ tenantId, contactId: dupB1, name: 'Marco Denton', email: 'marco@terracecafes.com', company: 'Terrace Café Group', stage: 'customer', owner: subjectOf('sofia-lindqvist'), customFields: { industry: 'Food & Beverage', region: 'East', tier: 'mid-market' }, identifiers: [ident('phone', '+15557654321')], ...SEED_EMIT });
    await createContact({ tenantId, contactId: dupB2, name: 'M. Denton', email: 'mdenton@terracecafes.com', company: 'Terrace Café Group', stage: 'lead', owner: subjectOf('sofia-lindqvist'), customFields: { industry: 'Food & Beverage', region: 'East', tier: 'mid-market' }, identifiers: [ident('phone', '+15557654321')], ...SEED_EMIT });
    await mergeContacts(tenantId, dupB1, dupB2, DEMO_CRM_ACTOR, { silent: true });
    created += 2;
  }

  // 4) Pipelines (idempotent by name).
  const existingPipes = await listPipelines(tenantId, orgId);
  const pipeByKey = new Map<string, { pipelineId: string; stageIds: string[] }>();
  for (const p of SOLSTICE_PIPELINES) {
    const found = existingPipes.find((x) => x.name === p.name);
    const pipeline = found ?? await createPipeline(tenantId, orgId, p.name, p.stages.map((s) => ({ name: s.name, probability: s.probability })), undefined, SEED_EMIT);
    pipeByKey.set(p.key, { pipelineId: pipeline.pipelineId, stageIds: pipeline.stages.map((s) => s.stageId) });
    if (!found) created += 1;
  }

  // 5) Deals (idempotent by deterministic id).
  const validators = makeLinkValidators(tenantId, orgId);
  const existingDealIds = new Set((await listDeals(tenantId, orgId)).map((d) => d.dealId));
  const dealSources = ['inbound', 'outbound', 'referral', 'renewal'];
  for (const [i, d] of SOLSTICE_DEALS.entries()) {
    if (existingDealIds.has(DEAL_ID(d.slug))) continue;
    const pipe = pipeByKey.get(d.pipeline)!;
    await createDeal({
      tenantId, orgId, dealId: DEAL_ID(d.slug), createdBy: DEMO_CRM_ACTOR,
      title: d.title, pipelineId: pipe.pipelineId, stageId: pipe.stageIds[d.stageIndex],
      amount: d.amount, currency: 'USD',
      companyId: COMPANY_ID(d.company), contactId: CONTACT_ID(d.company, 0),
      owner: subjectOf(d.rep), status: d.status, closeDate: ymd(nowMs, d.closeOffsetDays),
      customFields: { dealsource: dealSources[i % dealSources.length]! },
      validateCompany: validators.validateCompany, validateContact: validators.validateContact,
      ...SEED_EMIT,
    });
    created += 1;
  }

  // 6) Activities — ~2 per deal, backdated across the past 90 days. Idempotent by
  //    deterministic id (activities have no delete API and no id short-circuit).
  const actKinds = ['note', 'call', 'email', 'meeting'] as const;
  const existingActIds = new Set((await activityStore.listForTenantIndexed(tenantId)).map((a) => a.activityId));
  let actN = 0;
  for (const [i, d] of SOLSTICE_DEALS.entries()) {
    for (let j = 0; j < 2; j += 1) {
      const activityId = `act:demo-crm-${TID}-${d.slug}-${j}`;
      if (existingActIds.has(activityId)) { actN += 1; continue; }
      const kind = actKinds[(i + j) % actKinds.length]!;
      const daysAgo = 3 + ((i * 3 + j * 11) % 84);
      await createActivity({
        tenantId, orgId, kind, createdBy: DEMO_CRM_ACTOR, activityId,
        body: activityBody(kind, d.title),
        dealId: DEAL_ID(d.slug), companyId: COMPANY_ID(d.company), contactId: CONTACT_ID(d.company, 0),
        createdAt: new Date(nowMs - daysAgo * 86400_000).toISOString(),
        validators,
        ...SEED_EMIT,
      });
      actN += 1; created += 1;
    }
  }

  // 7) Tasks — 25 across the deals, assigned to their reps.
  let taskN = 0;
  const existingTaskIds = new Set((await listTasks(tenantId, orgId)).map((t) => t.taskId));
  for (const [i, d] of SOLSTICE_DEALS.entries()) {
    if (taskN >= 25) break;
    const taskId = `task:demo-crm-${TID}-${i}`;
    if (existingTaskIds.has(taskId)) { taskN += 1; continue; }
    await createTask({
      tenantId, orgId, taskId, createdBy: DEMO_CRM_ACTOR,
      title: taskTitle(d.title, i), status: i % 3 === 0 ? 'doing' : 'open',
      dueDate: ymd(nowMs, 2 + (i % 21)), assignee: subjectOf(d.rep),
      dealId: DEAL_ID(d.slug), companyId: COMPANY_ID(d.company),
      validators,
      ...SEED_EMIT,
    });
    taskN += 1; created += 1;
  }

  // 8) Segments (idempotent by deterministic id).
  const existingSegIds = new Set((await listSegments(tenantId)).map((s) => s.segmentId));
  for (const s of SOLSTICE_SEGMENTS) {
    const segmentId = demoCrmSegmentId(tenantId, s.slug);
    if (existingSegIds.has(segmentId)) continue;
    await createSegment({ tenantId, name: s.name, filters: s.filters, createdBy: DEMO_CRM_ACTOR, segmentId, ...SEED_EMIT });
    created += 1;
  }

  // 9) Weekly pipeline snapshots — ~13 backdated weeks per pipeline (the
  //    supported upsert path), so the pipeline trend charts show growth.
  await seedSnapshots(tenantId, orgId, nowMs, pipeByKey);

  const details = { companies: SOLSTICE_COMPANIES.length, deals: SOLSTICE_DEALS.length, activities: actN, tasks: taskN, segments: SOLSTICE_SEGMENTS.length };
  log.info('demo_crm_seeded', { tenantId, created, ...details });
  return { created, details };
}

function activityBody(kind: string, dealTitle: string): string {
  switch (kind) {
    case 'call': return `Discovery call re: ${dealTitle}. Walked through roast profiles and volumes; strong interest, sending samples.`;
    case 'email': return `Sent follow-up on ${dealTitle} with the wholesale price list and lead times.`;
    case 'meeting': return `On-site tasting for ${dealTitle}. Team liked the house blend; discussing a standing order.`;
    default: return `Note: ${dealTitle} — decision-maker confirmed budget for next quarter.`;
  }
}
function taskTitle(dealTitle: string, i: number): string {
  const verbs = ['Send samples for', 'Prepare proposal for', 'Follow up on', 'Schedule tasting for', 'Draft contract for'];
  return `${verbs[i % verbs.length]!} ${dealTitle}`;
}

/** Build backdated weekly snapshots from the deal set. */
async function seedSnapshots(
  tenantId: string, orgId: string, nowMs: number,
  pipeByKey: Map<string, { pipelineId: string; stageIds: string[] }>,
): Promise<void> {
  const WEEKS = 13;
  for (const p of SOLSTICE_PIPELINES) {
    const pipe = pipeByKey.get(p.key)!;
    // Current per-stage totals from the seeded deals.
    const perStageNow: StageSnapshotEntry[] = p.stages.map((s, idx) => {
      const deals = SOLSTICE_DEALS.filter((d) => d.pipeline === p.key && d.stageIndex === idx);
      const sum = deals.reduce((a, d) => a + d.amount, 0);
      return { stageId: pipe.stageIds[idx]!, name: s.name, count: deals.length, sum, weightedSum: Math.round((sum * s.probability) / 100) };
    });
    for (let w = 0; w < WEEKS; w += 1) {
      const factor = 0.55 + (0.45 * w) / (WEEKS - 1); // grow toward current
      const atMs = nowMs - (WEEKS - 1 - w) * 7 * 86400_000;
      const week = isoWeek(atMs);
      const perStage = perStageNow.map((e) => ({
        ...e, count: Math.round(e.count * factor), sum: Math.round(e.sum * factor), weightedSum: Math.round(e.weightedSum * factor),
      }));
      const snapshot: CrmSnapshot = {
        snapshotId: crmSnapshotId(tenantId, orgId, pipe.pipelineId, week),
        tenantId, orgId, pipelineId: pipe.pipelineId, isoWeek: week,
        at: new Date(atMs).toISOString(), perStage,
      };
      await upsertCrmSnapshot(snapshot);
    }
  }
}

export async function clearDemoCrm(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  const orgId = await orgIdFor(tenantId);
  let cleared = 0;
  const CONTACT_ID = (companySlug: string, k: number | string): string => demoCrmContactId(tenantId, companySlug, k);

  // Merge events (no delete API) → remove the demo ones outright so clear leaves
  // no audit orphan (the merged contacts are deleted below).
  for (const e of (await mergeEventStore.listForTenantIndexed(tenantId)).filter((x) => x.actor === DEMO_CRM_ACTOR)) {
    await mergeEventStore.delete(e.mergeEventId); cleared += 1;
  }
  // Activities + stage history + snapshots (no per-row delete API → direct store).
  for (const a of (await activityStore.listForTenantIndexed(tenantId)).filter((x) => x.createdBy === DEMO_CRM_ACTOR)) {
    await activityStore.delete(a.activityId); cleared += 1;
  }
  for (const r of (await stageHistoryStore.listForTenantIndexed(tenantId)).filter((x) => x.actor === DEMO_CRM_ACTOR)) {
    await stageHistoryStore.delete(r.historyId); cleared += 1;
  }
  // A pipeline is OURS only when its name AND full stage shape (names +
  // probabilities) match a canonical demo pipeline — never a user's like-named
  // "New Business" pipeline with different stages (review #1356 HIGH; the #1344
  // reuse-then-delete-by-name class). createPipeline has no createdBy marker, so
  // the canonical stage shape is the ownership signal.
  const demoPipes = (await listPipelines(tenantId, orgId)).filter(isDemoPipeline);
  const demoPipeIds = new Set(demoPipes.map((p) => p.pipelineId));
  for (const s of (await snapshotStore.listForTenantIndexed(tenantId)).filter((x) => demoPipeIds.has(x.pipelineId))) {
    await snapshotStore.delete(s.snapshotId); cleared += 1;
  }
  // Tasks, deals, segments (have delete APIs).
  for (const t of (await listTasks(tenantId, orgId)).filter((x) => x.createdBy === DEMO_CRM_ACTOR)) {
    if (await deleteTask(tenantId, orgId, t.taskId, SEED_EMIT)) cleared += 1;
  }
  for (const d of (await listDeals(tenantId, orgId)).filter((x) => x.createdBy === DEMO_CRM_ACTOR)) {
    if (await deleteDeal(tenantId, orgId, d.dealId, SEED_EMIT)) cleared += 1;
  }
  for (const s of (await listSegments(tenantId)).filter((x) => x.segmentId.startsWith('seg:demo-crm-'))) {
    if (await deleteSegment(tenantId, s.segmentId, SEED_EMIT)) cleared += 1;
  }
  // Contacts — the id-prefixed live ones, plus the (tombstoned) merged dup.
  for (const c of (await listContacts(tenantId)).filter((x) => x.contactId.startsWith('crm:demo-crm-'))) {
    if (await deleteContact(c.contactId, SEED_EMIT)) cleared += 1;
  }
  for (const id of [CONTACT_ID('dup', 'b2'), CONTACT_ID('dup', 'a2')]) {
    if (await deleteContact(id, SEED_EMIT)) cleared += 1;
  }
  // Companies, field defs, pipelines.
  for (const c of (await listCompanies(tenantId, orgId)).filter((x) => x.createdBy === DEMO_CRM_ACTOR)) {
    if (await deleteCompany(tenantId, orgId, c.companyId, SEED_EMIT)) cleared += 1;
  }
  const wantKeys = new Set(SOLSTICE_FIELD_DEFS.map((d) => d.key));
  for (const d of (await listFieldDefs(tenantId, orgId, 'deal')).filter((x) => wantKeys.has(x.key))) {
    if (await deleteFieldDef(tenantId, orgId, d.defId, SEED_EMIT)) cleared += 1;
  }
  for (const d of (await listContactFieldDefs(tenantId)).filter((x) => wantKeys.has(x.key))) {
    if (await deleteContactFieldDef(tenantId, d.defId, SEED_EMIT)) cleared += 1;
  }
  for (const p of demoPipes) {
    if (await deletePipeline(tenantId, orgId, p.pipelineId, SEED_EMIT)) cleared += 1;
  }

  log.info('demo_crm_cleared', { tenantId, cleared });
  return { cleared };
}
