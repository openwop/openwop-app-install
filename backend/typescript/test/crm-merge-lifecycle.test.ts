/**
 * CRM-5 — a merge fired NO lifecycle event, so ~20 cross-feature stores were left
 * pointing at the tombstone while `crmMergeService`'s own docblock claimed it
 * "RELINKS every referencing row … never a dangling reference to a tombstone".
 * It relinked three: deals, tasks, activities.
 *
 * The two consequences with the highest blast radius are the ones asserted here,
 * because they are the two that are compliance-grade rather than cosmetic:
 *
 *  1. `consent:record` is keyed on the contactId. A source contact that had opted
 *     OUT of marketing lost that record on merge — and the survivor became
 *     reachable at the source's ABSORBED email identifier. A recorded revocation
 *     silently became a permitted send.
 *  2. `email:sendlog` keys the per-recipient dedupe (`cmp:<campaignId>:<contactId>`)
 *     and the ADR 0267 frequency cap on the contactId, so the survivor could be
 *     RE-SENT a campaign the source had already received, at that same absorbed
 *     address, and the cap reset to zero.
 *
 * Every case asserts the OUTCOME (`isAllowed` / the pending audience the sender
 * computes), never merely that a handler ran. A handler-ran assertion would have
 * passed against a handler that moved nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createContact, getContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { mergeContacts, unmergeContacts } from '../src/features/crm/crmMergeService.js';
import { listMergeEvents } from '../src/features/crm/crmMergeEventsService.js';
import {
  recordConsent, getConsent, isAllowed, __resetConsentStore,
} from '../src/features/consent/consentService.js';
import { listSends, __resetEmailStore } from '../src/features/email/emailService.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';

const T = 'crm-merge-lifecycle-tenant';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  // `isAllowed` is permissive while the consent toggle is OFF, which would make
  // every assertion below vacuously true.
  const c = getToggleDefault('consent');
  if (c) await saveConfig({ ...c, status: 'on' }, 'test');
  // FOLD-IN B4 — the send-ledger relink handler is now gated on the `email` toggle
  // (a merge must not touch a store the tenant does not have the feature for), so
  // the ledger cases below would be vacuous with it off. Same reason as consent above.
  const e = getToggleDefault('email');
  if (e) await saveConfig({ ...e, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(async () => { await __resetCrmStore(); await __resetConsentStore(); await __resetEmailStore(); });

/** Write a send-log row directly — the shape `sendCampaign` writes for a delivered
 *  recipient. Going through a full campaign send would need a provider and adds
 *  nothing: the property under test is the LEDGER's contact key. */
async function writeSendLog(tenantId: string, campaignId: string, contactId: string, sendId: string): Promise<void> {
  const storage = __hostExtStorage();
  if (!storage) throw new Error('host-ext storage must be initialized');
  await storage.kvSet(`hostext:email:sendlog:${sendId}`, JSON.stringify({
    sendId, tenantId, campaignId, contactId, status: 'sent', ts: new Date().toISOString(),
  }));
}

async function twoContacts(): Promise<{ survivorId: string; sourceId: string }> {
  const survivor = await createContact({ tenantId: T, name: 'Survivor', stage: 'lead', email: 'survivor@acme.test' });
  const source = await createContact({ tenantId: T, name: 'Source', stage: 'lead', email: 'source@acme.test' });
  return { survivorId: survivor.contactId, sourceId: source.contactId };
}

describe("CRM-5 — a merge must not lose the source's opt-out", () => {
  it("the source's marketing opt-out survives the merge onto the survivor", async () => {
    const { survivorId, sourceId } = await twoContacts();
    await recordConsent({ tenantId: T, subjectKey: survivorId, categories: { marketing: true }, source: 'test' });
    await recordConsent({ tenantId: T, subjectKey: sourceId, categories: { marketing: false }, source: 'test' });

    // Precondition: the survivor is permitted BEFORE the merge, so the assertion
    // after it is measuring a change rather than a pre-existing denial.
    expect(await isAllowed(T, survivorId, 'marketing')).toBe(true);

    await mergeContacts(T, survivorId, sourceId, 'test');

    // The survivor now resolves at the source's absorbed email identifier, so it
    // MUST inherit the source's refusal. Before the fix it stayed `true`.
    expect(
      await isAllowed(T, survivorId, 'marketing'),
      "the survivor absorbed the source's address, so it must absorb the refusal too",
    ).toBe(false);
  });

  it('the fold is MOST-RESTRICTIVE, never latest-wins — a merge cannot GRANT permission', async () => {
    // The polarity that matters most: a merge is operator bookkeeping, not evidence
    // that anyone changed their mind, so a permissive source must not lift the
    // survivor's own refusal.
    const { survivorId, sourceId } = await twoContacts();
    await recordConsent({ tenantId: T, subjectKey: survivorId, categories: { marketing: false }, source: 'test' });
    await recordConsent({ tenantId: T, subjectKey: sourceId, categories: { marketing: true }, source: 'test' });

    await mergeContacts(T, survivorId, sourceId, 'test');
    expect(await isAllowed(T, survivorId, 'marketing')).toBe(false);
  });

  it('a per-channel specific the source never spoke to is not folded in as a denial', async () => {
    // `normCategories` stores a channel specific ONLY when the caller sent an
    // explicit boolean, because the absence means "the umbrella governs". Folding
    // an absent specific in as `false` would silently narrow the survivor on a
    // channel nobody ever refused.
    const { survivorId, sourceId } = await twoContacts();
    await recordConsent({ tenantId: T, subjectKey: survivorId, categories: { marketing: true, 'marketing.sms': true }, source: 'test' });
    await recordConsent({ tenantId: T, subjectKey: sourceId, categories: { marketing: true }, source: 'test' });

    await mergeContacts(T, survivorId, sourceId, 'test');
    expect(await isAllowed(T, survivorId, 'marketing.sms')).toBe(true);
  });

  it("the source's own consent row is left intact, so an unmerge is not lossy", async () => {
    // The first draft of the fix DELETED it, which would have destroyed a
    // revocation an unmerge had no way to restore — fixing a lost opt-out by
    // losing a different one.
    const { survivorId, sourceId } = await twoContacts();
    await recordConsent({ tenantId: T, subjectKey: sourceId, categories: { marketing: false }, source: 'test' });
    await mergeContacts(T, survivorId, sourceId, 'test');

    expect(await getConsent(T, sourceId), "the source's record must survive the merge").not.toBeNull();

    const [ev] = await listMergeEvents(T);
    expect(ev, 'a merge event must have been recorded').toBeTruthy();
    await unmergeContacts(T, ev!.mergeEventId);
    expect((await getContact(sourceId))?.mergedInto, 'the source is live again').toBeUndefined();
    expect(await isAllowed(T, sourceId, 'marketing'), "and it still holds its own refusal").toBe(false);
  });

  it('a merge with no source consent record changes nothing (the handler discriminates)', async () => {
    const { survivorId, sourceId } = await twoContacts();
    await recordConsent({ tenantId: T, subjectKey: survivorId, categories: { marketing: true }, source: 'test' });
    await mergeContacts(T, survivorId, sourceId, 'test');
    expect(await isAllowed(T, survivorId, 'marketing')).toBe(true);
  });
});

describe('CRM-5 — a merge must not let the survivor be re-sent the campaign the source got', () => {
  it("the source's send-log rows move to the survivor, restoring the dedupe key", async () => {
    const { survivorId, sourceId } = await twoContacts();
    await writeSendLog(T, 'cmp-1', sourceId, 'snd:merge-1');

    // Precondition: the ledger row exists and is keyed on the SOURCE.
    expect((await listSends(T, 'cmp-1')).map((s) => s.contactId)).toEqual([sourceId]);

    await mergeContacts(T, survivorId, sourceId, 'test');

    const after = await listSends(T, 'cmp-1');
    expect(
      after.map((s) => s.contactId),
      'the delivery record belongs to the survivor now — this IS the dedupe key sendCampaign reads',
    ).toEqual([survivorId]);
    // Not duplicated: a copy rather than a move would double the frequency-cap count.
    expect(after).toHaveLength(1);
    expect(after[0]!.mergedFrom, 'stamped so the move is reversible').toBe(sourceId);
  });

  it("an unmerge returns exactly the moved rows — never the survivor's own deliveries", async () => {
    // A naive "move everything back" would hand the survivor's pre-merge history to
    // the source: the same silent-loss family, one step downstream. The `mergedFrom`
    // stamp is what makes the inverse exact, and this case is what proves it.
    const { survivorId, sourceId } = await twoContacts();
    await writeSendLog(T, 'cmp-1', sourceId, 'snd:from-source');
    await writeSendLog(T, 'cmp-1', survivorId, 'snd:survivors-own');

    await mergeContacts(T, survivorId, sourceId, 'test');
    expect((await listSends(T, 'cmp-1')).every((s) => s.contactId === survivorId)).toBe(true);

    const [ev] = await listMergeEvents(T);
    await unmergeContacts(T, ev!.mergeEventId);

    const after = await listSends(T, 'cmp-1');
    expect(after.find((s) => s.sendId === 'snd:from-source')!.contactId).toBe(sourceId);
    expect(
      after.find((s) => s.sendId === 'snd:survivors-own')!.contactId,
      "the survivor's OWN delivery must not be handed to the source",
    ).toBe(survivorId);
    expect(after.find((s) => s.sendId === 'snd:from-source')!.mergedFrom, 'the stamp is cleared').toBeUndefined();
  });

  it("another tenant's send-log rows are untouched", async () => {
    const { survivorId, sourceId } = await twoContacts();
    await writeSendLog('some-other-tenant', 'cmp-1', sourceId, 'snd:foreign');
    await mergeContacts(T, survivorId, sourceId, 'test');
    const foreign = await listSends('some-other-tenant', 'cmp-1');
    expect(foreign.map((s) => s.contactId)).toEqual([sourceId]);
  });
});
