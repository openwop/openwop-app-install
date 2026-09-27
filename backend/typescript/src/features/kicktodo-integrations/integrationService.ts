/**
 * kicktodo-integrations (ADR 0421) — consent + the calendar FEED lane (P1)
 * and wearable evidence rules (P3).
 *
 * CONSENT-FIRST, NARROWEST-FIRST: every lane is an explicit revocable consent
 * record; the read-only ICS feed carries ZERO provider write scope; wearable
 * imports map a metric threshold to an idempotent check-in (recorded evidence
 * wins — the ADR 0414 rule) and retain only the mapped value + provenance.
 *
 * FEED TOKENS are capability-style: minted once (raw returned exactly once),
 * stored HASHED (sha256), resolved by hash, revocable; uniform 404 on
 * unknown/revoked. The feed exposes titles + day numbers only (ADR OQ3's
 * recommendation — calendar entries are semi-public on shared calendars).
 */

import { hashToken, mintToken } from '../../host/capabilityToken.js';
import { buildIcsCalendar, type IcsEvent } from '../../host/ics.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { createLogger } from '../../observability/logger.js';
import { listEnrollmentsFor, occurrencesOn } from '../kicktodo-core/enrollmentService.js';
import { onEnrollmentDeleted } from '../kicktodo-core/enrollmentLifecycle.js';
import { getChallenge } from '../kicktodo-core/challengeService.js';
import { localDateIn } from '../kicktodo-core/types.js';
import { submitCheckIn } from '../kicktodo-core/todayService.js';
import { recordWearableReading } from './wearableLivenessService.js';

const log = createLogger('kicktodo.integrations');

export type ConsentKind = 'calendar-project' | 'calendar-write' | 'wearable-evidence' | 'messaging-reminders';
export const CONSENT_KINDS: readonly ConsentKind[] = ['calendar-project', 'calendar-write', 'wearable-evidence', 'messaging-reminders'];

export interface IntegrationConsent {
  tenantId: string;
  ownerSubject: string;
  kind: ConsentKind;
  connectionId?: string;
  grantedAt: string;
  revokedAt?: string;
}

const consents = new DurableCollection<IntegrationConsent>(
  'kicktodo-consents',
  (c) => `${c.tenantId}::${c.ownerSubject}::${c.kind}`,
);

interface FeedRow {
  /** sha256 hash of the raw token — the ONLY stored form. */
  tokenHash: string;
  tenantId: string;
  ownerSubject: string;
  createdAt: string;
  revokedAt?: string;
}

/** Keyed by token HASH (global — the public route has no tenant). */
const feeds = new DurableCollection<FeedRow>('kicktodo-feed-tokens', (f) => f.tokenHash);

export interface WearableEvidenceRule {
  tenantId: string;
  enrollmentId: string;
  stableActivityId: string;
  metric: string;
  threshold: number;
  createdAt: string;
}

const rules = new DurableCollection<WearableEvidenceRule>(
  'kicktodo-wearable-rules',
  (r) => `${r.tenantId}::${r.enrollmentId}::${r.stableActivityId}`,
);

const nowIso = (): string => new Date().toISOString();

// ADR 0434 (KTFULL-B21) SUMMARY property-injection safety — creator-controlled
// activity titles are interpolated into `SUMMARY`, so a title containing CRLF
// could inject arbitrary iCalendar properties. The shared `host/ics.ts` builder
// (ADR 0454) does the RFC 5545 §3.3.11 escaping (incl. the Unicode line/para
// separators) for every field, so this feature no longer hand-rolls it.

export class ConsentRequiredError extends Error {
  constructor(public readonly kind: ConsentKind) {
    super(`This lane requires the \`${kind}\` consent first.`);
  }
}
export class FeedDeniedError extends Error {
  constructor() {
    super('Not found.'); // uniform — token invalid, revoked, or absent
  }
}

export async function grantConsent(
  tenantId: string,
  ownerSubject: string,
  kind: ConsentKind,
  connectionId?: string,
): Promise<IntegrationConsent> {
  const consent: IntegrationConsent = {
    tenantId,
    ownerSubject,
    kind,
    ...(connectionId ? { connectionId } : {}),
    grantedAt: nowIso(),
  };
  await consents.put(consent);
  log.info('kicktodo_consent_granted', { kind, tenantId });
  return consent;
}

export async function revokeConsent(tenantId: string, ownerSubject: string, kind: ConsentKind): Promise<void> {
  const c = await consents.get(`${tenantId}::${ownerSubject}::${kind}`);
  if (c && !c.revokedAt) await consents.put({ ...c, revokedAt: nowIso() });
  // Revoking the feed lane also revokes every live feed token (immediate).
  // NOTE: feeds is keyed by token HASH, so this is a full-collection scan —
  // acceptable ONLY because revocation is rare and renderFeed independently
  // re-checks liveConsent per request; never call this on a hot path.
  if (kind === 'calendar-project') {
    for (const f of await feeds.list()) {
      if (f.tenantId === tenantId && f.ownerSubject === ownerSubject && !f.revokedAt) {
        await feeds.put({ ...f, revokedAt: nowIso() });
      }
    }
  }
}

export async function liveConsent(tenantId: string, ownerSubject: string, kind: ConsentKind): Promise<IntegrationConsent | null> {
  const c = await consents.get(`${tenantId}::${ownerSubject}::${kind}`);
  return c && !c.revokedAt ? c : null;
}

export async function listConsents(tenantId: string, ownerSubject: string): Promise<IntegrationConsent[]> {
  return await consents.listByPrefix(`${tenantId}::${ownerSubject}::`);
}

/** Mint a feed token (consent-gated). The RAW token is returned exactly once. */
export async function mintFeedToken(tenantId: string, ownerSubject: string): Promise<string> {
  if (!(await liveConsent(tenantId, ownerSubject, 'calendar-project'))) throw new ConsentRequiredError('calendar-project');
  const { raw } = mintToken('ktfeed'); // ADR 0448 P1 — the host mint
  await feeds.put({ tokenHash: hashToken(raw), tenantId, ownerSubject, createdAt: nowIso() });
  return raw;
}

/** Render the ICS feed for a raw token (the PUBLIC lane). Titles + day
 *  numbers only; uniform denial on unknown/revoked tokens or revoked consent. */
export async function renderFeed(rawToken: string): Promise<string> {
  const row = await feeds.get(hashToken(rawToken));
  if (!row || row.revokedAt) throw new FeedDeniedError();
  // The operator kill-switch holds for already-minted feeds too: a tenant
  // whose toggle is OFF serves nothing (fail-closed; uniform 404).
  const assignment = await resolveOne('kicktodo-integrations', { tenantId: row.tenantId });
  if (!assignment || !assignment.enabled) throw new FeedDeniedError();
  if (!(await liveConsent(row.tenantId, row.ownerSubject, 'calendar-project'))) throw new FeedDeniedError();

  const events: IcsEvent[] = [];
  const enrollments = (await listEnrollmentsFor(row.tenantId, row.ownerSubject)).filter((e) => e.state === 'active');
  for (const e of enrollments) {
    const challenge = await getChallenge(row.tenantId, e.challengeId, e.challengeVersion);
    const date = localDateIn(e.timezone);
    const occs = await occurrencesOn(row.tenantId, e.id, date);
    for (const occ of occs) {
      const activity = challenge?.activities.find((a) => a.stableActivityId === occ.stableActivityId);
      events.push({
        uid: `${occ.cardId}@kicktodo`,
        start: { kind: 'date', value: occ.occurrenceDateLocal.replace(/-/g, '') },
        // Titles + day numbers ONLY (no instructions/notes — semi-public surface).
        summary: `KickTodo day ${activity?.day ?? ''}: ${activity?.title ?? occ.stableActivityId}`,
      });
    }
  }
  // The one shared RFC 5545 builder (ADR 0454) — spec-correct escaping + folding.
  return buildIcsCalendar({ prodId: '-//KickTodo//EN', events });
}

export class RuleError extends Error {}

/** P3 — a metric-threshold rule mapping wearable data to ONE activity's
 *  check-in evidence (owner-scoped; consent-gated at ingest). */
export async function putWearableRule(
  tenantId: string,
  ownerSubject: string,
  input: { enrollmentId: string; stableActivityId: string; metric: string; threshold: number },
): Promise<WearableEvidenceRule> {
  if (!input.metric.trim() || !Number.isFinite(input.threshold) || input.threshold <= 0) {
    throw new RuleError('A rule needs a metric and a positive threshold.');
  }
  const enrollments = await listEnrollmentsFor(tenantId, ownerSubject);
  if (!enrollments.some((e) => e.id === input.enrollmentId)) throw new FeedDeniedError();
  const rule: WearableEvidenceRule = {
    tenantId,
    enrollmentId: input.enrollmentId,
    stableActivityId: input.stableActivityId,
    metric: input.metric.trim(),
    threshold: input.threshold,
    createdAt: nowIso(),
  };
  await rules.put(rule);
  return rule;
}

/**
 * Ingest one wearable metric reading for the OWNER (consent-gated): every
 * matching rule whose threshold the value meets converts today's matching
 * occurrence into an idempotent check-in (recorded evidence wins) carrying
 * the mapped value + provenance ONLY — raw provider payloads are never kept.
 */
export async function ingestWearableMetric(
  tenantId: string,
  ownerSubject: string,
  metric: string,
  value: number,
): Promise<number> {
  if (!(await liveConsent(tenantId, ownerSubject, 'wearable-evidence'))) throw new ConsentRequiredError('wearable-evidence');
  // ADR 0462 P3 — a reading arrived ⇒ the stream is alive NOW (the staleness clock the
  // ADR 0460 wearable exception source reads). Stamped regardless of whether it
  // converts to a check-in below (a below-threshold reading is still liveness).
  await recordWearableReading(tenantId, ownerSubject);
  let converted = 0;
  const enrollments = (await listEnrollmentsFor(tenantId, ownerSubject)).filter((e) => e.state === 'active');
  for (const e of enrollments) {
    const enrollmentRules = await rules.listByPrefix(`${tenantId}::${e.id}::`);
    for (const rule of enrollmentRules) {
      if (rule.metric !== metric || value < rule.threshold) continue;
      const date = localDateIn(e.timezone);
      const occs = await occurrencesOn(tenantId, e.id, date);
      const occ = occs.find((o) => o.stableActivityId === rule.stableActivityId);
      if (!occ) continue;
      await submitCheckIn(tenantId, ownerSubject, occ.cardId, {
        note: `wearable:${metric}=${value} (threshold ${rule.threshold})`,
        measuredValue: value,
      });
      converted += 1;
    }
  }
  log.info('kicktodo_wearable_ingested', { metric, converted });
  return converted;
}

// ADR 0458 P0 — GDPR data-subject erasure (subjectErasure seam). Every integration lane is
// the SUBJECT's own consent/connection surface, so on a DSAR delete it all:
//   - consents (subject-keyed prefix) — the revocable per-lane grants;
//   - feed tokens (keyed by token HASH, but carry `ownerSubject`; scan — the same
//     full-collection scan revokeConsent already accepts, rare + off the hot path);
//   - wearable evidence rules — keyed by ENROLLMENT (no subject field), so resolve the
//     subject's enrollments and delete their rules. This reads enrollments at erase time;
//     integrations owns their removal on the subject seam because kicktodo-core has no
//     reverse edge to these rows and so cannot cascade them. (The `calendar-events` write
//     ledger is deliberately NOT erased here — see its own note in calendarWriteService.)
// Tenant-scoped, idempotent, no notifications.
export async function eraseIntegrationsSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  for (const c of await consents.listByPrefix(`${tenantId}::${subjectKey}::`)) {
    await consents.delete(`${c.tenantId}::${c.ownerSubject}::${c.kind}`);
  }
  for (const f of await feeds.list()) {
    if (f.tenantId === tenantId && f.ownerSubject === subjectKey) await feeds.delete(f.tokenHash);
  }
  for (const e of await listEnrollmentsFor(tenantId, subjectKey)) {
    for (const rule of await rules.listByPrefix(`${tenantId}::${e.id}::`)) {
      await rules.delete(`${rule.tenantId}::${rule.enrollmentId}::${rule.stableActivityId}`);
    }
  }
}
registerSubjectEraser(eraseIntegrationsSubject);

// ADR 0458 P0 — wearable rules are enrollment-keyed CHILDREN of kicktodo-core's
// enrollment rows. Their cleanup must not depend on subject-eraser ORDERING
// (the erasure seam guarantees none): when the OWNER deletes an enrollment —
// DSAR, abandon-purge, teardown — this keyed lifecycle subscription (the
// ADR 0288 contract) deletes the rules for exactly that enrollment. The
// subject eraser above remains as an independent, idempotent second path.
onEnrollmentDeleted('kicktodo-integrations.wearable-rules', async ({ tenantId, enrollmentId }) => {
  for (const rule of await rules.listByPrefix(`${tenantId}::${enrollmentId}::`)) {
    await rules.delete(`${rule.tenantId}::${rule.enrollmentId}::${rule.stableActivityId}`);
  }
});

// NO registerRetentionPurger (deliberate OMIT + reason): consents are a revocable CONSENT
// lifecycle (never aged out — a stale grant is revoked, not time-deleted); feed tokens are
// hashed capability tokens (`internal`, governed by revocation + a per-render consent
// re-check); wearable rules are `internal` configuration. None are aged `confidential-pii`,
// so this package is not consulted by the time-based sweep.

/** Test-only: the module-private collections, for erasure/seed assertions. */
export const __test = { consents, feeds, rules };
