/**
 * ADR 1036 D1 — WHO a campaign pass acts for.
 *
 * A pass runs one person's grants under one person's steering, so it needs that
 * person, and the run does not always carry one: a heartbeat run has no
 * `actingUserId`, and an approved run carries the APPROVER as its causing member
 * (ADR 0832 D3 — the person who caused it, which narrows and never grants). The
 * approver is not the job seeker, so neither run field can name the subject.
 *
 * The card can't either. The generic kanban routes copy `createdBy` from the
 * request body (`routes/kanban.ts`), so any board writer can file or edit a
 * campaign card that names a colleague. The first draft of ADR 1036 anchored on
 * it, and the `/architect` pass rejected that.
 *
 * So the subject is recorded HERE, in a row only `queueCampaignCard` writes,
 * insert-if-absent and never updated, with the authenticated caller as
 * `subjectId`. The run locates it through the card id in its host-written
 * `metadata.heartbeat` / `metadata.approval` block — keys `stripCallerAttribution`
 * removes from caller-supplied metadata, so a run starter cannot point at
 * someone else's card. A card with no row (filed through the generic kanban
 * route, or a crash between the card and the row) resolves to NOBODY, and the
 * pass refuses with a typed error rather than guessing.
 */
import { DurableCollection, hostExtStorage } from '../../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../../host/subjectErasure.js';
import { subjectKeyForms } from '../../../host/subjectErasureRedaction.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../../host/retentionPurger.js';
import type { BundleScope } from '../../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../../types.js';
import { actingUserIds } from '../../connections/connectionsService.js';

/**
 * The canonical (`user:`) spelling of a RUN-carried id in this tenant.
 *
 * Everything this package stores names a person by `resolveCallerUser(req).userId`
 * (grants, deals, steering, queue rows, attestations). A run carries `req.userId`,
 * which can still be the auth principal (`oidc:<sub>`) for a session or schedule
 * that predates the ADR 0003 move — the two-spellings class. Raw equality then
 * silently matches nothing. The alias comes from the ONE run-lane resolver
 * (`actingUserIds`), which only joins through the durable User row in the HOME
 * tenant, because a principal id is not issuer-qualified.
 */
export async function canonicalSubject(tenantId: string, id: string): Promise<string> {
  for (const x of await actingUserIds(tenantId, id)) if (x.startsWith('user:')) return x;
  return id;
}

export interface CampaignQueueRow {
  key: string; // `${tenantId}:${cardId}`
  tenantId: string;
  cardId: string;
  subjectId: string;
  createdAt: string;
}

export const campaignQueue = new DurableCollection<CampaignQueueRow>(
  'job-search:campaign-queue',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

/** Record who queued a card. Insert-if-absent: a row is never rewritten, so a
 *  later caller cannot re-point a card at themselves or anyone else. */
export async function recordCampaignQueue(tenantId: string, cardId: string, subjectId: string, now: number): Promise<boolean> {
  const key = `${tenantId}:${cardId}`;
  return campaignQueue.compareAndSwap(null, { key, tenantId, cardId, subjectId, createdAt: new Date(now).toISOString() });
}

export async function campaignQueueSubject(tenantId: string, cardId: string): Promise<string | null> {
  const row = await campaignQueue.get(`${tenantId}:${cardId}`);
  return row && row.tenantId === tenantId ? row.subjectId : null;
}

const cardIdOf = (metadata: unknown): string | null => {
  const m = (metadata ?? {}) as Record<string, unknown>;
  for (const block of [m.heartbeat, m.approval]) {
    const id = (block as { cardId?: unknown } | undefined)?.cardId;
    if (typeof id === 'string' && id) return id;
  }
  return null;
};

/** Bound on the fork walk: the same depth the CRM qualification frame uses. */
const MAX_FORK_DEPTH = 64;

/**
 * The person a `career.campaign` run acts for.
 *
 *  1. `actingUserId` — a member who started the run themselves.
 *  2. Else the queue row named by the run's host-written card id. A fork has no
 *     card block of its own, so it resolves through its ancestors (bounded,
 *     same tenant); the row is immutable, so the answer is the original's.
 *
 * The causing member (the approver) is deliberately NOT consulted (see the header).
 */
export async function resolveCampaignSubject(scope: BundleScope): Promise<string> {
  if (scope.actingUserId) return canonicalSubject(scope.tenantId, scope.actingUserId);
  let runId = scope.runId;
  const seen = new Set<string>();
  for (let depth = 0; runId && depth < MAX_FORK_DEPTH && !seen.has(runId); depth += 1) {
    seen.add(runId);
    const run = await hostExtStorage().getRun(runId);
    if (!run || run.tenantId !== scope.tenantId) break;
    const cardId = cardIdOf(run.metadata);
    if (cardId) {
      const subject = await campaignQueueSubject(scope.tenantId, cardId);
      if (subject) return subject;
      break;
    }
    runId = run.parentRunId;
  }
  throw new OpenwopError(
    'forbidden_scope',
    'This campaign run does not name the person it acts for. Queue it from the Auto-apply authority page, or start it yourself.',
    403,
    { reason: 'no_campaign_subject' },
  );
}

/** DSAR: the row links a person to a card. */
export async function eraseSubjectCampaignQueue(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const row of await campaignQueue.listByPrefix(`${tenantId}:`)) {
    if (forms.has(row.subjectId)) await campaignQueue.delete(row.key);
  }
}

registerSubjectEraser(eraseSubjectCampaignQueue);

// A queue row outlives its card's usefulness once the card ran; it is pacing
// metadata with a person attached, so it ages out on the store's PII window.
registerRetentionPurger({
  feature: 'job-search:campaign-queue',
  dryRun: 'rows-by-age',
  purge: async (tenantId, classification, cutoffIso) =>
    classification !== 'confidential-pii' ? 0 : purgeRowsByAge(
      'job-search:campaign-queue',
      await campaignQueue.listForTenantIndexed(tenantId),
      tenantId,
      cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.createdAt, id: r.key }),
      (id) => campaignQueue.delete(id),
    ),
});
