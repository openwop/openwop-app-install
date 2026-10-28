/**
 * ADR 0954 D6 — speed to lead: the first-touch clock after a lead is assigned.
 *
 * The clock runs as the tail of the `crm-ops.route-lead` chain (one run per
 * routing round): the route node's recorded output carries the assignment time,
 * the band's `firstTouchMinutes` and the client's business hours AS THEY WERE;
 * the pure `sla-deadline` node turns them into three instants (due, escalate,
 * report) frozen in its output and the run bag; `core.flow.wait` waits until
 * each; `check-first-touch` ends the chain on any owner activity or booking;
 * each `sla-rung` fires once per (round, rung), ledgered.
 *
 * Settings per client (`crm:lead-sla-settings`, `tenant::orgId`): the business
 * hours, what rung 2 does (Q2 decided: escalate by default; re-route is opt-in)
 * and who the agency lead is for rung 3.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ERASED, subjectKeyForms } from '../../../host/subjectErasureRedaction.js';
import { currentErasureRequest } from '../../../host/subjectErasure.js';
import { isErasureTombstoned, tombstoneId, tombstoneKeyForms, writeErasureTombstone } from '../../consent/consentService.js';
import { assertEffectAllowed } from '../../../host/runEffectContext.js';
import { DurableCollection, hostExtStorage } from '../../../host/hostExtPersistence.js';
import { resolveEffectiveAccess } from '../../../host/accessControlService.js';
import { resolveLeadTerritory } from '../../../host/leadTerritoryRouting.js';
import { getNotificationEmitter } from '../../../notifications/emitter.js';
import { OpenwopError } from '../../../types.js';
import { createLogger } from '../../../observability/logger.js';
import { isValidTimeZone, parseHhmm, type WeeklyHours } from '../bookingTime.js';
import { listActivities, listBookings } from '../crmEntitiesService.js';
import { getContact } from '../contactsService.js';
import { getLeadProfile } from './leadStore.js';
import { getRoutingDecision } from './routing.js';
import { routeLeadStarter } from './routeRun.js';

const log = createLogger('feature.crm.leadIntel.speedToLead');

export interface LeadSlaSettings {
  tenantId: string;
  orgId: string;
  /** IANA zone the business hours are in. Absent ⇒ the clock runs 24/7 (UTC). */
  timezone?: string;
  weeklyHours?: WeeklyHours[];
  /** Rung 2: escalate to the territory manager (or the agency lead), or re-route
   *  the lead to someone else. Default `escalate` (ADR 0954 Q2). */
  escalation: 'escalate' | 'reroute';
  /** Rung 3's recipient (an opaque subject). */
  agencyLead?: string;
  updatedBy: string;
  updatedAt: string;
}

interface StoredSettings extends LeadSlaSettings { publicationPending?: { operation: string; digest: string; subjectHashes: string[] }; publicationDisabled?: boolean }
const settingsStore = new DurableCollection<StoredSettings>('crm:lead-sla-settings', (s) => `${s.tenantId}::${s.orgId}`, undefined, (s) => s.tenantId);
type RungRow = { key: string; tenantId: string; orgId: string; contactId: string; routingEpoch: number; rung: 1 | 2 | 3; runId: string; outcome: string; at: string; nextRunId?: string; nextEpoch?: number; notice?: { recipientHash: string; outcome: string } };

const rungs = new DurableCollection<RungRow>(
  'crm:lead-sla-rung', (r) => r.key, undefined, (r) => r.tenantId,
);

const invalid = (field: string, message: string): OpenwopError => new OpenwopError('validation_error', message, 422, { field });

export async function getSlaSettings(tenantId: string, orgId: string): Promise<LeadSlaSettings | null> {
  const s = await settingsStore.get(`${tenantId}::${orgId}`);
  if (!s || s.tenantId !== tenantId || s.orgId !== orgId) return null;
  if (s.publicationPending || s.publicationDisabled) throw new OpenwopError('conflict', 'Lead response-time settings are incomplete. Retry the save.', 409, { reason: 'sla_settings_pending' });
  return publicSettings(s);
}

/** Save a client's settings. A field left out keeps its saved value; `null`
 *  clears it (so a partial update never silently drops the agency lead). */
export async function saveSlaSettings(tenantId: string, orgId: string, input: unknown, actor: string): Promise<LeadSlaSettings> {
  const b = (input ?? {}) as Record<string, unknown>;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('settings', 'Settings must be an object.');
  for (let attempt = 0; attempt < 5; attempt++) {
  const prev = await settingsStore.get(`${tenantId}::${orgId}`);
  const escalation = b.escalation === undefined ? (prev?.escalation ?? 'escalate') : b.escalation;
  if (escalation !== 'escalate' && escalation !== 'reroute') throw invalid('escalation', 'escalation is "escalate" or "reroute".');
  const row: LeadSlaSettings = { tenantId, orgId, escalation, updatedBy: actor, updatedAt: new Date().toISOString() };
  const timezone = b.timezone === undefined ? prev?.timezone : b.timezone;
  if (timezone !== null && timezone !== undefined) {
    if (typeof timezone !== 'string' || !isValidTimeZone(timezone)) throw invalid('timezone', 'timezone must be an IANA zone, e.g. "America/New_York".');
    row.timezone = timezone;
  }
  const weeklyHours = b.weeklyHours === undefined ? prev?.weeklyHours : b.weeklyHours;
  if (weeklyHours !== null && weeklyHours !== undefined) {
    if (!row.timezone) throw invalid('weeklyHours', 'Business hours need a timezone.');
    if (!Array.isArray(weeklyHours) || weeklyHours.length === 0 || weeklyHours.length > 21) throw invalid('weeklyHours', 'Give 1 to 21 weekly windows.');
    row.weeklyHours = weeklyHours.map((w, i) => {
      const r = (w ?? {}) as Record<string, unknown>;
      const start = typeof r.start === 'string' ? parseHhmm(r.start) : null;
      const end = typeof r.end === 'string' ? parseHhmm(r.end) : null;
      if (typeof r.day !== 'number' || !Number.isInteger(r.day) || r.day < 0 || r.day > 6 || start === null || end === null || end <= start) {
        throw invalid(`weeklyHours[${i}]`, 'A window is { day: 0–6, start: "HH:MM", end: "HH:MM" } with end after start.');
      }
      return { day: r.day, start: r.start as string, end: r.end as string };
    });
  }
  const agencyLead = b.agencyLead === undefined ? prev?.agencyLead : b.agencyLead;
  if (agencyLead !== null && agencyLead !== undefined) {
    if (typeof agencyLead !== 'string' || !/^[^\s]{1,200}$/.test(agencyLead)) throw invalid('agencyLead', 'agencyLead is one subject id.');
    row.agencyLead = agencyLead;
  }
  const digest = createHash('sha256').update(JSON.stringify({ ...row, updatedAt: undefined, updatedBy: tombstoneId(tenantId, actor) })).digest('hex');
  const subjects = [actor, ...(row.agencyLead ? [row.agencyLead] : [])].filter((subject) => subject !== ERASED);
  let pending: StoredSettings;
  if (prev?.publicationPending) {
    if (prev.publicationPending.digest !== digest) throw new OpenwopError('conflict', 'Another settings save is in progress. Retry after it completes.', 409, { reason: 'sla_settings_conflict' });
    pending = prev;
  } else {
    // Existing attributed content may stay on the primary; NEW subjects appear
    // only after their staged receipt and tombstone reads. A contender either
    // retries against the current row or gets a typed conflict, never a lost edit.
    pending = { ...row, updatedBy: prev?.updatedBy ?? ERASED,
      publicationPending: { operation: randomUUID(), digest, subjectHashes: [...new Set(subjects.flatMap((subject) => tombstoneKeyForms(subject).map((form) => tombstoneId(tenantId, form))))] } };
    if (prev?.agencyLead) pending.agencyLead = prev.agencyLead; else delete pending.agencyLead;
    if (!(await settingsStore.compareAndSwap(prev, pending))) continue;
  }
  for (const subject of subjects) for (const form of tombstoneKeyForms(subject)) {
    if (await isErasureTombstoned(tenantId, form)) throw new OpenwopError('conflict', 'A settings participant was erased. Refresh and retry.', 409, { reason: 'sla_settings_subject_erased' });
  }
  const published: StoredSettings = { ...row, updatedAt: pending.updatedAt };
  if (!(await settingsStore.compareAndSwap(pending, published))) throw new OpenwopError('conflict', 'These settings changed during publication. Refresh and retry.', 409, { reason: 'sla_settings_conflict' });
  return publicSettings(published);
  }
  throw new OpenwopError('conflict', 'These settings kept changing. Retry.', 409, { reason: 'sla_settings_conflict' });
}

function publicSettings({ publicationPending: _pending, publicationDisabled: _disabled, ...row }: StoredSettings): LeadSlaSettings { return row; }

/** Reuse CRM's subject-erasure pass and staged-primary barrier. A delayed
 * settings writer cannot restore an erased agency lead or editor attribution. */
export async function eraseSlaSettingsSubjects(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const forms = [...new Set([...subjectKeyForms(subjectKey).forms].flatMap(tombstoneKeyForms))];
  const hashes = new Set(forms.map((form) => tombstoneId(tenantId, form)));
  const request = currentErasureRequest();
  const dsarHash = tombstoneId(tenantId, request?.tenantId === tenantId ? request.requestedKey : subjectKey);
  for (const form of forms) await writeErasureTombstone(tenantId, form, dsarHash);
  const matches = (subject: string): boolean => tombstoneKeyForms(subject).some((form) => forms.includes(form));
  for (const candidate of await rungs.listByPrefix(`${tenantId}::`)) {
    if (candidate.tenantId !== tenantId || !candidate.notice || !hashes.has(candidate.notice.recipientHash)) continue;
    // Keep the hashed cancellation receipt: an old insert may still be in
    // flight. Its retry must clean that exact inbox id even after restart.
    const sealed = { ...candidate, outcome: 'superseded' };
    if (!(await rungs.compareAndSwap(candidate, sealed))) {
      const current = await rungs.get(candidate.key);
      if (current?.notice && current.outcome !== 'superseded' && hashes.has(current.notice.recipientHash)) throw new Error('lead_sla_notice_erasure_conflict');
    }
  }
  for (const candidate of await settingsStore.listByPrefix(`${tenantId}::`)) {
    if (candidate.tenantId !== tenantId) continue;
    let done = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await settingsStore.get(`${tenantId}::${candidate.orgId}`);
      if (!row) { done = true; break; }
      const pending = row.publicationPending?.subjectHashes.some((hash) => hashes.has(hash));
      if (!pending && !matches(row.updatedBy) && !(row.agencyLead && matches(row.agencyLead))) { done = true; break; }
      const next: StoredSettings = { ...row, updatedBy: matches(row.updatedBy) ? ERASED : row.updatedBy };
      if (next.agencyLead && matches(next.agencyLead)) delete next.agencyLead;
      if (pending) { delete next.publicationPending; next.publicationDisabled = true; }
      if (await settingsStore.compareAndSwap(row, next)) { done = true; break; }
    }
    if (!done) throw new Error('lead_sla_settings_erasure_conflict');
  }
}

/**
 * Was the lead touched since it was assigned in this routing round? An owner
 * activity (any kind the owner logged, `createdAt` between assignment and now,
 * so a back-dated sync or a future-dated booking slot cannot count early) or a
 * booking made since assignment (its claim time, not its slot time).
 */
export async function checkFirstTouch(tenantId: string, orgId: string, contactId: string, routingEpoch: number): Promise<{ touched: boolean; firstTouchAt?: string; owner?: string }> {
  const decision = await getRoutingDecision(tenantId, orgId, contactId, routingEpoch);
  if (!decision) throw new OpenwopError('not_found', 'Routing record not found.', 404, { contactId, routingEpoch });
  if (!decision.chosen) return { touched: false };
  const since = decision.decidedAt;
  const now = new Date().toISOString();
  const touches: string[] = [];
  for (const a of await listActivities(tenantId, orgId, { contactId })) {
    if (a.createdBy === decision.chosen && a.createdAt >= since && a.createdAt <= now) touches.push(a.createdAt);
  }
  for (const b of await listBookings(tenantId, orgId)) {
    if (b.contactId === contactId && b.status !== 'cancelled' && b.createdAt >= since && b.createdAt <= now) touches.push(b.createdAt);
  }
  touches.sort();
  return touches.length > 0 ? { touched: true, firstTouchAt: touches[0]!, owner: decision.chosen } : { touched: false, owner: decision.chosen };
}

/** The recorded rung of a round, if it fired. */
export async function getSlaRung(tenantId: string, orgId: string, contactId: string, routingEpoch: number, rung: 1 | 2 | 3): Promise<{ outcome: string; runId: string; at: string } | null> {
  const r = await rungs.get(`${tenantId}::${orgId}::${contactId}::${routingEpoch}::${rung}`);
  return r && r.tenantId === tenantId && r.orgId === orgId ? { outcome: r.outcome, runId: r.runId, at: r.at } : null;
}

/** A re-route, or a newer routing round, ends this round's clock: the new
 *  owner's round is a new decision with its own clock (its own run). */
export const clockContinues = (outcome: string): boolean => !outcome.startsWith('rerout') && outcome !== 'superseded';

/**
 * Reserve one rung per (round, rung). Pending delivery is recoverable: the
 * durable notification's unique id is its receipt, and an uncertain child
 * start reconciles the same deterministic routing run. A retry reports fired:false.
 * A round that is no longer the lead's current one is `superseded` (a later
 * Route action or a rung-2 re-route started a new clock).
 *
 * A rung-2 re-route starts a NEW routing round as its own `crm-ops.route-lead`
 * run (grade → route excluding this owner → its own clock), bumping only from
 * this round. Its row is claimed as `rerouting` first and finished as
 * `rerouted` with the new run; a retry that finds `rerouting` resumes it, and a
 * round a person moved on meanwhile finishes as `superseded`.
 */
export async function fireSlaRung(input: { tenantId: string; orgId: string; contactId: string; routingEpoch: number; rung: 1 | 2 | 3; runId: string; causedBy?: string }): Promise<{ outcome: string; fired: boolean }> {
  const { tenantId, orgId, contactId, routingEpoch, rung } = input;
  const key = `${tenantId}::${orgId}::${contactId}::${routingEpoch}::${rung}`;
  const existing = await rungs.get(key);
  if (existing) return { outcome: existing.outcome === 'rerouting' ? await finishReroute(existing, input) : existing.notice ? await finishNotice(existing) : existing.outcome, fired: false };
  const decision = await getRoutingDecision(tenantId, orgId, contactId, routingEpoch);
  if (!decision) throw new OpenwopError('not_found', 'Routing record not found.', 404, { contactId, routingEpoch });
  const profile = await getLeadProfile(tenantId, orgId, contactId);
  const contact = await getContact(contactId);
  const settings = await getSlaSettings(tenantId, orgId);
  let outcome = 'none';
  const recipients: string[] = [];
  if (!profile || profile.status === 'closed' || profile.routingEpoch !== routingEpoch || !contact || contact.tenantId !== tenantId || contact.mergedInto) {
    outcome = 'superseded';
  } else if (rung === 1) {
    if (decision.chosen && await canSeeClient(tenantId, orgId, decision.chosen)) { outcome = 'reminded-owner'; recipients.push(decision.chosen); }
    else outcome = 'reminder-unaddressed';
  } else if (rung === 2 && settings?.escalation === 'reroute') {
    outcome = 'rerouting';
  } else if (rung === 2) {
    const territory = await resolveLeadTerritory(tenantId, orgId, { stage: contact?.stage, source: profile?.source });
    const manager = territory?.managerSubjectId && await canSeeClient(tenantId, orgId, territory.managerSubjectId) ? territory.managerSubjectId : undefined;
    const lead = !manager && settings?.agencyLead && await canSeeClient(tenantId, orgId, settings.agencyLead) ? settings.agencyLead : undefined;
    if (manager) { outcome = 'escalated-manager'; recipients.push(manager); }
    else if (lead) { outcome = 'escalated-agency-lead'; recipients.push(lead); }
    else outcome = 'escalation-unaddressed';
  } else if (rung === 3) {
    if (settings?.agencyLead && await canSeeClient(tenantId, orgId, settings.agencyLead)) { outcome = 'reported-agency-lead'; recipients.push(settings.agencyLead); }
    else outcome = 'report-unaddressed';
  }
  if (outcome === 'rerouting') assertEffectAllowed('dispatch', 'crm.lead.sla');
  else assertEffectAllowed('notification', 'crm.lead.sla');
  const row: RungRow = { key, tenantId, orgId, contactId, routingEpoch, rung, runId: decision.runId, outcome: recipients.length ? 'notifying' : outcome, at: new Date().toISOString(),
    ...(recipients[0] ? { notice: { recipientHash: tombstoneId(tenantId, recipients[0]), outcome } } : {}) };
  if (!(await rungs.compareAndSwap(null, row))) {
    const winner = await rungs.get(key);
    if (!winner) throw new OpenwopError('conflict', 'The response-time rung could not be confirmed. Retry.', 409, {});
    return { outcome: winner.outcome === 'rerouting' ? await finishReroute(winner, input) : winner.notice ? await finishNotice(winner) : winner.outcome, fired: false };
  }
  if (outcome === 'rerouting') return { outcome: await finishReroute(row, input), fired: true };
  if (row.notice) return { outcome: await finishNotice(row), fired: true };
  if (outcome.endsWith('unaddressed')) log.warn('lead_sla_rung_unaddressed', { tenantId, orgId, contactId, routingEpoch, rung });
  return { outcome, fired: true };
}

/** Start the new round (excluding the owner who missed the target) and record
 *  how it went. Idempotent per round: the bump is conditional on this round. */
async function finishReroute(row: RungRow, input: { causedBy?: string }): Promise<string> {
  const started = await routeLeadStarter()({
    tenantId: row.tenantId, orgId: row.orgId, contactId: row.contactId, fromEpoch: row.routingEpoch,
    sourceRunId: row.runId,
    ...(input.causedBy ? { causedBy: input.causedBy } : {}),
  });
  const done: RungRow = started ? { ...row, outcome: 'rerouted', nextRunId: started.runId, nextEpoch: started.routingEpoch } : { ...row, outcome: 'superseded' };
  await rungs.compareAndSwap(row, done);
  return done.outcome;
}

/** A rung links to a lead, so its recipient must be able to read this client now
 *  (re-checked at send time: a manager or agency lead who lost access is skipped). */
async function canSeeClient(tenantId: string, orgId: string, subject: string): Promise<boolean> {
  try {
    for (const form of tombstoneKeyForms(subject)) if (await isErasureTombstoned(tenantId, form)) return false;
    return (await resolveEffectiveAccess(tenantId, { subject, orgId })).scopes.includes('workspace:read');
  } catch {
    return false;
  }
}

/** Pending notices keep only the salted recipient hash. Resolve the same
 * participant from the live owners before every attempt; a changed recipient
 * never inherits somebody else's pending notice. The notification table's
 * unique id owns durable delivery; the rung acknowledges only a real row.
 * SSE/push/email retain the existing emitter's best-effort contract. */
async function finishNotice(row: RungRow): Promise<string> {
  const { tenantId, orgId, contactId, routingEpoch, rung } = row;
  const notice = row.notice!;
  assertEffectAllowed('notification', 'crm.lead.sla');
  const id = 'crm-lead-sla-' + createHash('sha256').update(JSON.stringify([row.key, notice.recipientHash])).digest('hex').slice(0, 32);
  const storage = hostExtStorage();
  const removeCancelled = async (): Promise<void> => {
    const saved = await storage.getNotification(id);
    if (saved && saved.tenantId === tenantId && saved.type === 'crm.lead.sla'
      && saved.recipientUserId && tombstoneId(tenantId, saved.recipientUserId) === notice.recipientHash) await storage.deleteNotification(id);
  };
  if (row.outcome === 'superseded') { await removeCancelled(); return row.outcome; }
  const decision = await getRoutingDecision(tenantId, orgId, contactId, routingEpoch);
  const profile = await getLeadProfile(tenantId, orgId, contactId);
  let recipient: string | undefined;
  const settings = await getSlaSettings(tenantId, orgId);
  if (rung === 1) recipient = decision?.chosen ?? undefined;
  else if (notice.outcome === 'escalated-manager') {
    const contact = await getContact(contactId);
    recipient = (await resolveLeadTerritory(tenantId, orgId, { stage: contact?.stage, source: profile?.source }))?.managerSubjectId;
  } else recipient = settings?.agencyLead;
  const allowed = async (): Promise<boolean> => {
    const current = await getLeadProfile(tenantId, orgId, contactId);
    const staged = await rungs.get(row.key);
    return !!recipient && tombstoneId(tenantId, recipient) === notice.recipientHash && !!current && current.status !== 'closed'
      && current.routingEpoch === routingEpoch && (staged?.outcome === notice.outcome || (staged?.outcome === 'notifying' && !!staged.notice))
      && await canSeeClient(tenantId, orgId, recipient);
  };
  let outcome = 'superseded';
  if (await allowed()) {
    const matches = async (): Promise<boolean> => {
      const saved = await storage.getNotification(id);
      return !!saved && saved.tenantId === tenantId && saved.recipientUserId === recipient && saved.type === 'crm.lead.sla';
    };
    if (!(await matches())) {
      try {
        await getNotificationEmitter().emit({ notificationId: id, tenantId, recipientUserId: recipient!, type: 'crm.lead.sla', priority: rung === 1 ? 'normal' : 'high',
          ...RUNG_COPY[rung], actionUrl: `/campaign-studio?client=${encodeURIComponent(orgId)}&lead=${encodeURIComponent(contactId)}`,
          metadata: { kind: 'crm.lead.sla', orgId, contactId, rung },
        });
      } catch (error) {
        // A thrown insert acknowledgement may already have committed. A real
        // row is the receipt; a placeholder/memo alone is never delivery.
        if (!(await matches())) throw error;
      }
    }
    if (!(await matches())) throw new OpenwopError('service_unavailable', 'The reminder is still pending. Retry.', 503, { reason: 'sla_notice_pending' });
    if (await allowed()) outcome = notice.outcome;
    else {
      const latest = await rungs.get(row.key);
      if (latest?.outcome === notice.outcome && !latest.notice) return latest.outcome;
      await removeCancelled();
    }
  } else {
    const latest = await rungs.get(row.key);
    if (latest?.outcome === notice.outcome && !latest.notice) return latest.outcome;
    await removeCancelled();
  }
  const done = { ...row, outcome }; delete done.notice;
  if (!(await rungs.compareAndSwap(row, done))) {
    const winner = await rungs.get(row.key);
    if (winner?.outcome === 'superseded') { await removeCancelled(); return winner.outcome; }
    if (!winner || winner.notice) throw new OpenwopError('conflict', 'The reminder acknowledgement is pending. Retry.', 409, {});
    return winner.outcome;
  }
  return outcome;
}

const RUNG_COPY: Record<1 | 2 | 3, { title: string; message: string }> = {
  1: { title: 'First touch due', message: 'An assigned lead has reached its response target. Open the client to review it.' },
  2: { title: 'Lead response escalated', message: 'A lead missed its first-touch target. Open the client to review it.' },
  3: { title: 'Missed first touch', message: 'A lead was not contacted inside its response target. Open the client to review it.' },
};
