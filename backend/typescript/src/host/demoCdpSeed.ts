/**
 * `demo-cdp` seeder (app-seeding-strategy.md §4 Phase 7, ADR 0262–0270).
 *
 * The CDP showcase over the Phase-3 CRM + Phase-4 commerce: event schemas (one
 * versioned), a volume of collected + analytics events with identity stitching
 * (so GoldenRecord/segment estimates/traits/attribution are non-empty), consent,
 * destination syncs (CDC + event), a segment-enrolled journey with a holdout, and
 * scoped developer keys. `dependsOn: ['demo-crm','demo-commerce-depth']`.
 *
 * Honesty notes:
 * - No CDP/analytics create function supports backdating (all stamp server-now),
 *   so the time-series (collected + analytics events, identity links) is written
 *   through tenant-indexed direct `DurableCollection` handles with demo-prefixed
 *   ids/keys — the only way to spread `at`/`ts` over 45 days AND keep clear
 *   surgical (these stores carry no `createdBy`). app-seeding-strategy.md §5's
 *   "last resort" — the handles replicate the real stores' id + tenant index.
 * - The journey seeds real enrollment records + a holdout split over a segment;
 *   a live-advancing `timer` interrupt needs an executing run (the executor, not
 *   a seeder), so it is a recorded deferral — the enrollment surface is real.
 * - Each sub-step is toggle-gated and skips honestly (never flips a toggle).
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { listContacts } from '../features/crm/contactsService.js';
import { registerEventSchema, listEventSchemas } from '../features/cdp/eventSchemaService.js';
import { setPolicy, getPolicy, recordConsent, listConsent, deleteSubject, readmitSubject } from '../features/consent/consentService.js';
import { createDestinationSync, listDestinationSyncs, deleteDestinationSync, prepareSyncBatch } from '../features/destination-sync/destinationSyncService.js';
import { issueApiKey, revokeApiKey, listApiKeys } from '../features/developer-keys/apiKeyService.js';
import { resolveSegment, enroll, listEnrollments, resetEnrollment } from '../features/campaign-journeys/journeyService.js';
import { holdoutArm } from '../features/campaign-journeys/surface.js';
import { demoCrmSegmentId } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoCdp');

const DEMO_CDP_ACTOR = 'demo:cdp';
const JOURNEY_ID = 'demo-cdp-welcome-series';
const ANALYTICS_COUNT = 1800;
const COLLECTED_COUNT = 400;
const SESSION_COUNT = 400;
const LINK_COUNT = 40;
const sess = (n: number): string => `demo-cdp-sess-${n}`;

// Direct handles: backdated time-series (no service backdate hook) + clear for
// the no-delete / no-createdBy stores.
const collectedStore = new DurableCollection<{ eventId: string; tenantId: string; eventType: string; payload: Record<string, unknown>; piiFields: string[]; schemaVersion?: number; at: string }>('cdp:collected-event', (e) => e.eventId, undefined, (e) => e.tenantId);
const analyticsStore = new DurableCollection<{ eventId: string; tenantId: string; orgId: string; type: string; ts: string; sessionKey?: string; path?: string; name?: string; utm?: Record<string, string>; clickIds?: Record<string, string>; props?: Record<string, unknown> }>('analytics:event', (e) => e.eventId, undefined, (e) => e.tenantId);
const identityStore = new DurableCollection<{ key: string; tenantId: string; sessionKey: string; contactId: string; source: string; at: string }>('analytics:identity-link', (l) => l.key, undefined, (l) => l.tenantId);
const eventSchemaStore = new DurableCollection<{ key: string; tenantId: string; eventType: string }>('cdp:event-schema', (s) => s.key, undefined, (s) => s.tenantId);
const devkeyStore = new DurableCollection<{ keyId: string; tenantId: string; createdBy?: string; tokenHash?: string }>('devkey:record', (k) => k.keyId, undefined, (k) => k.tenantId);
const devkeyHashStore = new DurableCollection<{ tokenHash: string; keyId?: string; tenantId?: string }>('devkey:hashidx', (h) => h.tokenHash, undefined, (h) => h.tenantId ?? '');

const DEMO_EVENT_TYPES = ['page_view', 'product_viewed', 'checkout_completed'];
const DEMO_SYNC_PREFIX = 'Demo — ';

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}
async function gate(id: string, tenantId: string): Promise<boolean> {
  return Boolean((await resolveOne(id, { tenantId }))?.enabled);
}
function ago(nowMs: number, days: number): string {
  return new Date(nowMs - days * 86400_000).toISOString();
}

export async function countDemoCdp(tenantId: string): Promise<number> {
  return (await collectedStore.listForTenantIndexed(tenantId)).filter((e) => e.eventId.startsWith('evt:demo-cdp-c-')).length;
}

export async function seedDemoCdp(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  const orgId = await orgIdFor(tenantId);
  const nowMs = Date.now();
  const [cdpOn, analyticsOn, consentOn, syncOn, journeyOn, devkeysOn] = await Promise.all([
    gate('cdp', tenantId), gate('analytics', tenantId), gate('consent', tenantId),
    gate('destination-sync', tenantId), gate('campaign-journeys', tenantId), gate('developer-keys', tenantId),
  ]);
  let created = 0;
  const skipped: string[] = [];

  const demoContacts = (await listContacts(tenantId)).filter((c) => c.contactId.startsWith('crm:demo-crm-')).map((c) => c.contactId);

  // 1) Event schemas (page_view, product_viewed, checkout_completed×2 versions).
  if (cdpOn) {
    const have = new Set((await listEventSchemas(tenantId)).map((s) => s.eventType));
    if (!have.has('page_view')) { await registerEventSchema(tenantId, 'page_view', { type: 'object', properties: { path: { type: 'string' }, referrer: { type: 'string' } } }); created += 1; }
    if (!have.has('product_viewed')) { await registerEventSchema(tenantId, 'product_viewed', { type: 'object', properties: { productId: { type: 'string' }, price: { type: 'number' } } }); created += 1; }
    // checkout_completed: register v1 then v2 (adds email) — two versions.
    const checkoutVersions = (await eventSchemaStore.listForTenantIndexed(tenantId)).filter((s) => s.eventType === 'checkout_completed').length;
    if (checkoutVersions < 1) { await registerEventSchema(tenantId, 'checkout_completed', { type: 'object', properties: { orderId: { type: 'string' }, total: { type: 'number' } } }); created += 1; }
    if (checkoutVersions < 2) { await registerEventSchema(tenantId, 'checkout_completed', { type: 'object', properties: { orderId: { type: 'string' }, total: { type: 'number' }, email: { type: 'string' } } }); created += 1; }

    // Collected events (~400 over 45 days; some PII-tagged).
    if (!(await collectedStore.listForTenantIndexed(tenantId)).some((e) => e.eventId.startsWith('evt:demo-cdp-c-'))) {
      for (let i = 0; i < COLLECTED_COUNT; i += 1) {
        const type = DEMO_EVENT_TYPES[i % 3]!;
        const isCheckout = type === 'checkout_completed';
        const payload: Record<string, unknown> = isCheckout
          ? { orderId: `ord-${i}`, total: 20 + (i % 60), email: `shopper${i % SESSION_COUNT}@example.com` }
          : type === 'product_viewed' ? { productId: `prod-${i % 24}`, price: 16 + (i % 30) } : { path: ['/shop', '/product', '/cart', '/'][i % 4], referrer: 'google' };
        await collectedStore.put({ eventId: `evt:demo-cdp-c-${tenantId}-${i}`, tenantId, eventType: type, payload, piiFields: isCheckout ? ['email'] : [], ...(isCheckout ? { schemaVersion: 2 } : {}), at: ago(nowMs, i % 45) });
        created += 1;
      }
    }
  } else skipped.push('cdp');

  // 2) Analytics events (~1800) + identity links (40) — the volume that makes
  //    GoldenRecord, segment estimates, traits, and attribution non-empty.
  if (analyticsOn) {
    if (!(await analyticsStore.listForTenantIndexed(tenantId)).some((e) => e.eventId.startsWith('evt:demo-cdp-a-'))) {
      const types = ['pageview', 'pageview', 'pageview', 'event', 'conversion'];
      const sources = ['google', 'newsletter', 'instagram', 'direct', 'partner'];
      for (let i = 0; i < ANALYTICS_COUNT; i += 1) {
        const type = types[i % types.length]!;
        await analyticsStore.put({
          eventId: `evt:demo-cdp-a-${tenantId}-${i}`, tenantId, orgId, type, ts: ago(nowMs, (i * 7) % 45),
          sessionKey: sess(i % SESSION_COUNT),
          path: ['/', '/shop', '/product', '/cart', '/checkout'][i % 5],
          utm: { source: sources[i % sources.length]!, medium: type === 'conversion' ? 'cpc' : 'organic', campaign: 'fy26-launch' },
          ...(i % 11 === 0 ? { clickIds: { gclid: `gcl-${i}` } } : {}),
          ...(type === 'conversion' ? { name: 'purchase', props: { value: 20 + (i % 80) } } : {}),
        });
        created += 1;
      }
    }
    // Identity links: stitch the first LINK_COUNT sessions to real contacts.
    if (demoContacts.length && !(await identityStore.listForTenantIndexed(tenantId)).some((l) => l.sessionKey.startsWith('demo-cdp-sess-'))) {
      for (let i = 0; i < LINK_COUNT; i += 1) {
        const sessionKey = sess(i);
        await identityStore.put({ key: `${tenantId}::${sessionKey}`, tenantId, sessionKey, contactId: demoContacts[i % demoContacts.length]!, source: i % 2 ? 'email-click' : 'form-submit', at: ago(nowMs, i % 30) });
        created += 1;
      }
    }
  } else skipped.push('analytics');

  // 3) Consent — 1 policy + 40 records (some opted-out) keyed to demo sessions.
  if (consentOn) {
    // Guard: never clobber a tenant's real consent policy (review #1363 MEDIUM).
    if (!(await getPolicy(tenantId))) await setPolicy(tenantId, { regulatedRegions: ['EU', 'CA', 'UK'], defaultMode: 'opt-in' });
    const regions = ['US', 'EU', 'CA', 'UK'];
    const existing = new Set((await listConsent(tenantId)).map((c) => c.subjectKey));
    for (let i = 0; i < LINK_COUNT; i += 1) {
      const subjectKey = sess(i);
      if (existing.has(subjectKey)) continue;
      const optedOut = i % 5 === 0; // ~20% decline marketing
      await recordConsent({ tenantId, subjectKey, source: DEMO_CDP_ACTOR, region: regions[i % regions.length], legalBasis: 'consent', categories: { necessary: true, analytics: true, marketing: !optedOut } });
      created += 1;
    }
  } else skipped.push('consent');

  // 4) Destination syncs — CDC (CRM→warehouse) + event webhook; a dry-run over a
  //    couple of records shows the RFC 0128 purpose-label drop path.
  if (syncOn) {
    const syncNames = new Set((await listDestinationSyncs(tenantId)).map((s) => s.name));
    let cdcSync;
    if (!syncNames.has(`${DEMO_SYNC_PREFIX}CRM → Warehouse (CDC)`)) {
      cdcSync = await createDestinationSync({ tenantId, name: `${DEMO_SYNC_PREFIX}CRM → Warehouse (CDC)`, destinationKind: 'bigquery', sourceObject: 'contact', syncMode: 'cdc', cursorField: 'updatedAt', fieldMap: [{ from: 'email', to: 'email_address' }, { from: 'name', to: 'full_name' }, { from: 'stage', to: 'lifecycle_stage' }] });
      created += 1;
    }
    if (!syncNames.has(`${DEMO_SYNC_PREFIX}Events → Webhook`)) {
      await createDestinationSync({ tenantId, name: `${DEMO_SYNC_PREFIX}Events → Webhook`, destinationKind: 'webhook', sourceObject: 'event', syncMode: 'event', fieldMap: [{ from: 'eventType', to: 'event' }, { from: 'at', to: 'timestamp' }] });
      created += 1;
    }
    if (cdcSync) {
      // Dry-run: one record labelled no-onward-use is dropped; the other passes.
      const dry = prepareSyncBatch(cdcSync, [
        { email: 'a@example.com', name: 'Ada', stage: 'customer', updatedAt: ago(nowMs, 1), permittedPurposes: ['analytics'] },
        { email: 'b@example.com', name: 'Bo', stage: 'lead', updatedAt: ago(nowMs, 1), permittedPurposes: [] },
      ], { dropNoOnwardUse: true });
      log.info('demo_cdp_sync_dryrun', { tenantId, prepared: dry.count, dropped: dry.dropped });
    }
  } else skipped.push('destination-sync');

  // 5) Journey — enroll a segment's contacts with a 20% holdout (control).
  if (journeyOn) {
    const { contactIds } = await resolveSegment(tenantId, demoCrmSegmentId(tenantId, 'cafe-accounts'));
    for (const contactId of contactIds) {
      if (holdoutArm(contactId, JOURNEY_ID, 20).arm === 'control') continue; // holdout
      const r = await enroll(tenantId, JOURNEY_ID, contactId);
      if (r.enrolled) created += 1;
    }
  } else skipped.push('campaign-journeys');

  // 6) Developer keys — 1 active scoped key + 1 revoked (only hashes persist).
  if (devkeysOn) {
    if (!(await listApiKeys(tenantId, { callerSubject: DEMO_CDP_ACTOR, isAdmin: true })).some((k) => k.createdBy === DEMO_CDP_ACTOR)) {
      await issueApiKey({ tenantId, name: 'Demo Storefront Ingest Key', createdBy: DEMO_CDP_ACTOR, scopes: ['events:write'] });
      const revoked = await issueApiKey({ tenantId, name: 'Demo Rotated Key (revoked)', createdBy: DEMO_CDP_ACTOR, scopes: ['events:write'] });
      await revokeApiKey(tenantId, revoked.key.keyId, { callerSubject: DEMO_CDP_ACTOR, isAdmin: true });
      created += 2;
    }
  } else skipped.push('developer-keys');

  log.info('demo_cdp_seeded', { tenantId, created, skipped });
  return { created, details: { analytics: ANALYTICS_COUNT, collected: COLLECTED_COUNT, skipped } };
}

export async function clearDemoCdp(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  let cleared = 0;
  for (const e of (await collectedStore.listForTenantIndexed(tenantId)).filter((x) => x.eventId.startsWith('evt:demo-cdp-c-'))) { await collectedStore.delete(e.eventId); cleared += 1; }
  for (const e of (await analyticsStore.listForTenantIndexed(tenantId)).filter((x) => x.eventId.startsWith('evt:demo-cdp-a-'))) { await analyticsStore.delete(e.eventId); cleared += 1; }
  for (const l of (await identityStore.listForTenantIndexed(tenantId)).filter((x) => x.sessionKey.startsWith('demo-cdp-sess-'))) { await identityStore.delete(l.key); cleared += 1; }
  for (const s of (await eventSchemaStore.listForTenantIndexed(tenantId)).filter((x) => DEMO_EVENT_TYPES.includes(x.eventType))) { await eventSchemaStore.delete(s.key); cleared += 1; }
  // Consent records (deleteSubject fans to erasers); policy has no delete API — left.
  // ADR 0657 D10 — a DSAR leaves a tombstone that is a WRITE BARRIER, so a re-seed would be
  // refused (`subject_erased`). These are synthetic demo subjects, not people: lift the
  // tombstone through the ONE sanctioned clearer (attested, audited), never a side door.
  for (const c of (await listConsent(tenantId)).filter((x) => x.subjectKey.startsWith('demo-cdp-sess-'))) {
    await deleteSubject(tenantId, c.subjectKey);
    await readmitSubject(tenantId, c.subjectKey, 'demo-cdp teardown (clearDemoCdp): synthetic demo subject, not a person.');
    cleared += 1;
  }
  for (const s of (await listDestinationSyncs(tenantId)).filter((x) => x.name.startsWith(DEMO_SYNC_PREFIX))) { if (await deleteDestinationSync(tenantId, s.syncId)) cleared += 1; }
  for (const e of await listEnrollments(tenantId, JOURNEY_ID)) { if (await resetEnrollment(tenantId, JOURNEY_ID, e.contactId)) cleared += 1; }
  // Developer keys (no delete API → direct store; drop the hash index too).
  for (const k of (await devkeyStore.listForTenantIndexed(tenantId)).filter((x) => x.createdBy === DEMO_CDP_ACTOR)) {
    if (k.tokenHash) await devkeyHashStore.delete(k.tokenHash).catch(() => undefined);
    await devkeyStore.delete(k.keyId); cleared += 1;
  }
  log.info('demo_cdp_cleared', { tenantId, cleared });
  return { cleared };
}
