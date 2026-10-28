/**
 * ADR 0954 D5 — route one lead to an owner under its client's policy.
 *
 * - Rules are tried in order; the first whose `match` fits and which yields an
 *   eligible owner wins. `territory` asks territories (through the host seam)
 *   and rotates within the matched territory's members; `round-robin` rotates a
 *   pool through a CAS pointer row, so concurrent arrivals each take a distinct
 *   turn; `capacity` picks the least-loaded pool member under `maxOpenLeads`
 *   (ties by rotation); `named` is one owner.
 * - Eligibility is checked AT ASSIGNMENT: a candidate must hold `workspace:write`
 *   on THIS client org now. Ineligible candidates are skipped and recorded, so a
 *   lead is never routed to someone outside the client. Nobody eligible ⇒ the
 *   client's unassigned queue.
 * - Ledgered on (contactId, routingEpoch): the decision row is inserted once, so a
 *   crash-resume of the same node returns the recorded decision instead of
 *   turning the rotation again.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { resolveEffectiveAccess } from '../../../host/accessControlService.js';
import { resolveLeadTerritory } from '../../../host/leadTerritoryRouting.js';
import { getNotificationEmitter } from '../../../notifications/emitter.js';
import { OpenwopError } from '../../../types.js';
import { createLogger } from '../../../observability/logger.js';
import { tombstoneId } from '../../consent/consentService.js';
import { getContact } from '../contactsService.js';
import { commitLeadRoutingDecision, getLeadGrade, getLeadProfile, getLeadRoutingDecision, getPendingLeadRoute, listLeadRoutingCapacityProfiles, restorePendingGrade, type LeadSource } from './leadStore.js';
import { V0_MODEL_ID, type Band } from './model.js';
import { getModelVersion } from './modelStore.js';
import { getSlaSettings } from './speedToLead.js';
import { latestRoutingPolicy, type LeadRoutingRule, type RoutingStrategy } from './routingPolicy.js';

const log = createLogger('feature.crm.leadIntel.routing');

export interface RoutingDecision {
  key: string;
  tenantId: string;
  orgId: string;
  contactId: string;
  routingEpoch: number;
  runId: string;
  policyVersion: number | null;
  ruleId: string | null;
  strategy: RoutingStrategy | null;
  candidates: string[];
  skipped: Array<{ subject: string; reason: 'not_eligible' | 'at_capacity' | 'previous_owner' }>;
  chosen: string | null;
  pointerBefore: number | null;
  decidedAt: string;
  sla?: { firstTouchMinutes: number; assignedAt: string; timezone?: string; weeklyHours?: Array<{ day: number; start: string; end: string }> } | null;
}

interface OwnerClaim { leadHash: string; epoch: number }
interface RoutingPointer { tenantId: string; orgId: string; poolId: string; next: number; reservations?: OwnerClaim[] }
const pointers = new DurableCollection<RoutingPointer>(
  'crm:lead-rr', (p) => `${p.tenantId}::${p.orgId}::${p.poolId}`, undefined, (p) => p.tenantId,
);

/** All strategies reserve their pending ownership in the existing routing
 * pointer store, so a concurrent capacity admission sees it BEFORE assignment.
 * Only tenant-salted contact/owner hashes live here. Reservations have no time
 * expiry: an uncertain primary commit must keep its capacity until a newer
 * epoch, closure or a different committed owner proves it cannot land.
 * Actual open owners and pending reservations are deduplicated by contact. */
async function reserveOwner(tenantId: string, orgId: string, contactId: string, epoch: number, owner: string, maximum?: number): Promise<boolean> {
  const poolId = `capacity:${tombstoneId(tenantId, owner)}`;
  const leadHash = tombstoneId(tenantId, contactId);
  const key = `${tenantId}::${orgId}::${poolId}`;
  for (let attempt = 0; attempt < 16; attempt++) {
    const current = await pointers.get(key);
    const profiles = await listLeadRoutingCapacityProfiles(tenantId, orgId);
    const live = new Map(profiles.map((profile) => [tombstoneId(tenantId, profile.contactId), profile]));
    const own = live.get(leadHash);
    if (!own || !own.pending || own.routingEpoch !== epoch || own.status === 'closed') throw new OpenwopError('conflict', 'This routing round no longer owns an open lead.', 409, { reason: 'routing_superseded' });
    const reservations = (current?.reservations ?? []).filter((claim) => {
      const profile = live.get(claim.leadHash);
      return profile && profile.status !== 'closed' && profile.routingEpoch === claim.epoch
        && (profile.assignedRoutingEpoch === claim.epoch ? profile.owner === owner : profile.pending);
    });
    const occupied = new Set(profiles.filter((profile) => profile.owner === owner && profile.status !== 'closed').map((profile) => tombstoneId(tenantId, profile.contactId)));
    for (const claim of reservations) occupied.add(claim.leadHash);
    occupied.delete(leadHash); // Reassigning the same lead consumes no second slot.
    if (maximum !== undefined && occupied.size >= maximum) return false;
    if (!reservations.some((claim) => claim.leadHash === leadHash && claim.epoch === epoch)) reservations.push({ leadHash, epoch });
    const next: RoutingPointer = { tenantId, orgId, poolId, next: current?.next ?? 0, reservations };
    if (await pointers.compareAndSwap(current, next)) return true;
  }
  throw new OpenwopError('conflict', 'This owner’s lead capacity kept changing. Retry.', 409, { reason: 'routing_capacity_conflict' });
}

const decisionKey = (tenantId: string, orgId: string, contactId: string, epoch: number): string => `${tenantId}::${orgId}::${contactId}::${epoch}`;

export async function getRoutingDecision(tenantId: string, orgId: string, contactId: string, epoch: number): Promise<RoutingDecision | null> {
  return getLeadRoutingDecision(tenantId, orgId, contactId, epoch);
}

/** Take the next turn of a pool (CAS): returns the turn index before the bump. */
async function takeTurn(tenantId: string, orgId: string, poolId: string): Promise<number> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const key = `${tenantId}::${orgId}::${poolId}`;
    const cur = await pointers.get(key);
    const next = { tenantId, orgId, poolId, next: (cur?.next ?? 0) + 1 };
    if (await pointers.compareAndSwap(cur, next)) return cur?.next ?? 0;
  }
  throw new OpenwopError('conflict', 'Too many leads arrived at once for this pool. Try again.', 409, { poolId });
}

async function eligible(tenantId: string, orgId: string, subject: string): Promise<boolean> {
  try {
    return (await resolveEffectiveAccess(tenantId, { subject, orgId })).scopes.includes('workspace:write');
  } catch {
    return false;
  }
}

function ruleMatches(rule: LeadRoutingRule, lead: { band?: Band; source: LeadSource }): boolean {
  const m = rule.match;
  if (!m) return true;
  if (m.bands && (!lead.band || !m.bands.includes(lead.band))) return false;
  if (m.sources && !m.sources.includes(lead.source)) return false;
  return true;
}

/** Route one lead for THIS run; idempotent per (contactId, routingEpoch). */
export async function routeLead(input: { tenantId: string; orgId: string; contactId: string; routingEpoch: number; runId: string; excludeOwnerHashes?: readonly string[] }): Promise<{ decision: RoutingDecision; replayed: boolean }> {
  const { tenantId, orgId, contactId, routingEpoch, runId } = input;
  const exclude = new Set(input.excludeOwnerHashes ?? []);
  const recorded = await getRoutingDecision(tenantId, orgId, contactId, routingEpoch);
  if (recorded) {
    await restorePendingGrade(tenantId, orgId, contactId, recorded.runId);
    return { decision: recorded, replayed: true };
  }

  const profile = await getLeadProfile(tenantId, orgId, contactId);
  if (!profile) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
  if (profile.status === 'closed') throw new OpenwopError('conflict', 'This lead is closed.', 409, { reason: 'lead_closed' });
  if (profile.routingEpoch !== routingEpoch) throw new OpenwopError('conflict', 'A newer routing round owns this lead.', 409, { reason: 'routing_superseded' });
  const contact = await getContact(contactId);
  if (!contact || contact.tenantId !== tenantId || contact.mergedInto) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
  const grade = await getLeadGrade(tenantId, orgId, contactId);
  const reservation = await getPendingLeadRoute(tenantId, orgId, contactId);
  if (!reservation || reservation.runId !== runId || reservation.pin.routingEpoch !== routingEpoch
    || grade?.runId !== runId || grade.modelId !== reservation.pin.modelId || grade.modelVersion !== reservation.pin.modelVersion || grade.modelHash !== reservation.pin.modelHash) {
    // Another executor may have committed and cleared the grade reservation
    // after this invocation's first history read. Reconcile that result.
    const winner = await getRoutingDecision(tenantId, orgId, contactId, routingEpoch);
    if (winner) return { decision: winner, replayed: true };
    throw new OpenwopError('conflict', 'This routing run has no current matching grade.', 409, { reason: 'routing_grade_superseded' });
  }
  if (JSON.stringify(input.excludeOwnerHashes ?? []) !== JSON.stringify(reservation.pin.excludeOwnerHashes ?? [])) throw new OpenwopError('forbidden_scope', 'The route exclusions do not match its frozen reservation.', 403, { reason: 'routing_exclusion_mismatch' });
  const policy = await latestRoutingPolicy(tenantId, orgId);
  const lead = {
    stage: contact.stage, ...(contact.company ? { company: contact.company } : {}),
    ...(profile.owner ? { owner: profile.owner } : {}),
    source: profile.source, ...(grade?.band ? { band: grade.band } : {}),
    ...(typeof grade?.score === 'number' ? { score: grade.score } : {}),
  };

  const skipped: RoutingDecision['skipped'] = [];
  let chosen: string | null = null;
  let ruleId: string | null = null;
  let strategy: RoutingStrategy | null = null;
  let candidates: string[] = [];
  let pointerBefore: number | null = null;

  for (const rule of policy?.rules ?? []) {
    if (!ruleMatches(rule, lead)) continue;
    let pool: string[] = [];
    let poolId = rule.ruleId;
    if (rule.strategy === 'territory') {
      const match = await resolveLeadTerritory(tenantId, orgId, lead);
      if (!match) continue;
      pool = [...match.memberSubjectIds];
      poolId = `territory:${match.territoryId}`;
    } else if (rule.strategy === 'named') {
      pool = rule.named ? [rule.named] : [];
    } else {
      pool = rule.pool ?? [];
    }
    const ok: string[] = [];
    for (const subject of pool) {
      if (exclude.has(tombstoneId(tenantId, subject))) { skipped.push({ subject, reason: 'previous_owner' }); continue; }
      if (await eligible(tenantId, orgId, subject)) ok.push(subject);
      else skipped.push({ subject, reason: 'not_eligible' });
    }
    let ordered = ok;
    if (rule.strategy === 'capacity') {
      const open = new Map<string, number>();
      for (const p of await listLeadRoutingCapacityProfiles(tenantId, orgId)) {
        if (p.contactId !== contactId && p.owner && (p.status === 'new' || p.status === 'working')) open.set(p.owner, (open.get(p.owner) ?? 0) + 1);
      }
      const under = ok.filter((s) => {
        const full = (open.get(s) ?? 0) >= (rule.maxOpenLeads ?? Infinity);
        if (full) skipped.push({ subject: s, reason: 'at_capacity' });
        return !full;
      });
      // Keep fallback candidates: a concurrent reservation can consume the
      // apparent least-loaded owner's last slot after this advisory snapshot.
      ordered = under.sort((a, b) => (open.get(a) ?? 0) - (open.get(b) ?? 0));
    }
    if (ordered.length === 0) continue;
    if (rule.strategy !== 'named') {
      pointerBefore = await takeTurn(tenantId, orgId, poolId);
    }
    if (rule.strategy === 'capacity') {
      // Rotate within each equal-load group, retaining least-loaded ordering.
      const loads = new Map<string, number>();
      for (const profile of await listLeadRoutingCapacityProfiles(tenantId, orgId)) if (profile.owner && profile.status !== 'closed') loads.set(profile.owner, (loads.get(profile.owner) ?? 0) + 1);
      const grouped = new Map<number, string[]>();
      for (const subject of ordered) { const count = loads.get(subject) ?? 0; grouped.set(count, [...(grouped.get(count) ?? []), subject]); }
      ordered = [...grouped.entries()].sort(([a], [b]) => a - b).flatMap(([, group]) => {
        const offset = (pointerBefore ?? 0) % group.length;
        return [...group.slice(offset), ...group.slice(0, offset)];
      });
    } else if (rule.strategy !== 'named') {
      const offset = (pointerBefore ?? 0) % ordered.length;
      ordered = [...ordered.slice(offset), ...ordered.slice(0, offset)];
    }
    for (const subject of ordered) {
      if (await reserveOwner(tenantId, orgId, contactId, routingEpoch, subject, rule.strategy === 'capacity' ? rule.maxOpenLeads : undefined)) { chosen = subject; break; }
      skipped.push({ subject, reason: 'at_capacity' });
    }
    if (!chosen) continue;
    ruleId = rule.ruleId;
    strategy = rule.strategy;
    candidates = ordered;
    break;
  }

  const decidedAt = new Date().toISOString();
  const decision: RoutingDecision = {
    key: decisionKey(tenantId, orgId, contactId, routingEpoch), tenantId, orgId, contactId, routingEpoch, runId,
    policyVersion: policy?.version ?? null, ruleId, strategy, candidates, skipped, chosen, pointerBefore,
    decidedAt,
    sla: chosen ? await slaSnapshot(tenantId, orgId, grade, decidedAt) : null,
  };
  const committed = await commitLeadRoutingDecision(decision);
  await restorePendingGrade(tenantId, orgId, contactId, committed.decision.runId);
  if (committed.replayed) return committed;
  if (chosen) {
    await notifyOwner(tenantId, orgId, contactId, routingEpoch, chosen);
  } else {
    log.info('lead_unassigned', { tenantId, orgId, contactId, routingEpoch, skipped: skipped.length });
  }
  return committed;
}

async function notifyOwner(tenantId: string, orgId: string, contactId: string, epoch: number, owner: string): Promise<void> {
  try {
    const current = await getLeadProfile(tenantId, orgId, contactId);
    if (!current || current.status === 'closed' || current.routingEpoch !== epoch || current.owner !== owner || !(await eligible(tenantId, orgId, owner))) return;
    // Notices contain only the opaque authorized reference: a late insert must
    // not restore contact names after erasure or disclose them after ACL loss.
    const notificationId = `crm-lead-assigned-${createHash('sha256').update([tenantId, orgId, contactId, String(epoch), owner].join('\u0000')).digest('hex').slice(0, 32)}`;
    await getNotificationEmitter().emit({
      notificationId, tenantId, recipientUserId: owner, type: 'crm.lead.assigned', priority: 'normal',
      title: 'New lead assigned',
      message: 'A new lead was assigned to you. Open Leads to view it.',
      actionUrl: `/campaign-studio?client=${encodeURIComponent(orgId)}&lead=${encodeURIComponent(contactId)}`,
      metadata: { kind: 'crm.lead.assigned', orgId, contactId },
    });
  } catch (err) {
    log.debug('lead_assign_notify_failed', { contactId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The band's first-touch target under the model that graded the lead, with the
 *  client's business hours, as they are at assignment. */
async function slaSnapshot(
  tenantId: string, orgId: string,
  grade: { band?: Band; modelId?: string; modelVersion?: number } | null,
  assignedAt: string,
): Promise<RoutingDecision['sla']> {
  if (!grade?.band || grade.modelId === undefined || grade.modelVersion === undefined) return null;
  const model = grade.modelId === V0_MODEL_ID ? null : await getModelVersion(tenantId, orgId, grade.modelId, grade.modelVersion);
  const minutes = model?.sla[grade.band]?.firstTouchMinutes;
  if (!minutes) return null;
  const settings = await getSlaSettings(tenantId, orgId);
  return {
    firstTouchMinutes: minutes, assignedAt,
    ...(settings?.timezone ? { timezone: settings.timezone } : {}),
    ...(settings?.weeklyHours ? { weeklyHours: settings.weeklyHours } : {}),
  };
}
