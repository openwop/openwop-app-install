/**
 * ADR 0462 Phase 1 — the wearable provider→subject link store. Pins:
 *  - fail-closed on `wearable-evidence` consent (can't link without opting in);
 *  - first-write-wins per (provider, providerUserId) — no hijack of a provider
 *    account to a second subject;
 *  - resolve (the webhook's reverse lookup) + ownership-checked unlink;
 *  - erasure (ADR 0381) drops the subject's links,
 *    leaving a co-subject's and another tenant's links intact.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { grantConsent } from '../src/features/kicktodo-integrations/integrationService.js';
import {
  linkWearableProvider,
  resolveSubjectForProviderUser,
  unlinkWearableProvider,
  listWearableLinksForSubject,
  eraseWearableLinksForSubject,
  __resetWearableLinks,
} from '../src/features/kicktodo-integrations/wearableLinkService.js';

const T = 'tenant-wl';
const SUBJECT = 'user:wl-owner';
const OTHER = 'user:wl-other';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetWearableLinks();
});

async function consent(subject = SUBJECT) {
  await grantConsent(T, subject, 'wearable-evidence');
}

describe('wearable link store (ADR 0462 P1)', () => {
  it('fails closed without a live wearable-evidence consent', async () => {
    await expect(linkWearableProvider(T, SUBJECT, 'fitbit', 'fb-123')).rejects.toThrow('wearable-evidence');
    expect(await resolveSubjectForProviderUser(T, 'fitbit', 'fb-123')).toBeNull();
  });

  it('links under consent + resolves the provider account to the subject', async () => {
    await consent();
    await linkWearableProvider(T, SUBJECT, 'fitbit', 'fb-123');
    expect(await resolveSubjectForProviderUser(T, 'fitbit', 'fb-123')).toBe(SUBJECT);
    // tenant-scoped: another tenant never resolves it.
    expect(await resolveSubjectForProviderUser('other-tenant', 'fitbit', 'fb-123')).toBeNull();
  });

  it('first-write-wins — a second subject cannot hijack a provider account', async () => {
    await consent(SUBJECT);
    await consent(OTHER);
    await linkWearableProvider(T, SUBJECT, 'fitbit', 'fb-123');
    await linkWearableProvider(T, OTHER, 'fitbit', 'fb-123'); // conflicting claim
    expect(await resolveSubjectForProviderUser(T, 'fitbit', 'fb-123')).toBe(SUBJECT); // first binding kept
  });

  it('KTINT-2 — two subjects claiming one provider account CONCURRENTLY: one binding, both told the truth', async () => {
    // Breaks if `linkWearableProvider` goes back to get → put (sabotage-witnessed:
    // both reads see "absent", both put, and the SECOND writer takes the binding
    // while the first was told it had linked).
    await consent(SUBJECT);
    await consent(OTHER);
    const [a, b] = await Promise.all([
      linkWearableProvider(T, SUBJECT, 'fitbit', 'fb-race'),
      linkWearableProvider(T, OTHER, 'fitbit', 'fb-race'),
    ]);
    const bound = await resolveSubjectForProviderUser(T, 'fitbit', 'fb-race');
    expect(a.ownerSubject, 'a caller was told it linked an account bound to someone else').toBe(bound);
    expect(b.ownerSubject, 'a caller was told it linked an account bound to someone else').toBe(bound);
  });

  it('unlink removes only the CALLER\'s own binding', async () => {
    await consent();
    await linkWearableProvider(T, SUBJECT, 'fitbit', 'fb-123');
    await unlinkWearableProvider(T, OTHER, 'fitbit', 'fb-123'); // not the owner ⇒ no-op
    expect(await resolveSubjectForProviderUser(T, 'fitbit', 'fb-123')).toBe(SUBJECT);
    await unlinkWearableProvider(T, SUBJECT, 'fitbit', 'fb-123'); // owner ⇒ removed
    expect(await resolveSubjectForProviderUser(T, 'fitbit', 'fb-123')).toBeNull();
  });

  it('lists the subject\'s links; erasure drops them (ADR 0381)', async () => {
    const T2 = 'tenant-wl-2';
    await consent();
    await consent(OTHER);
    await grantConsent(T2, SUBJECT, 'wearable-evidence');
    await linkWearableProvider(T, SUBJECT, 'fitbit', 'fb-123');
    await linkWearableProvider(T, SUBJECT, 'oura', 'ou-9');
    await linkWearableProvider(T, OTHER, 'fitbit', 'fb-other');  // co-subject, same tenant
    await linkWearableProvider(T2, SUBJECT, 'fitbit', 'fb-123'); // same subject, other tenant
    expect((await listWearableLinksForSubject(T, SUBJECT)).map((l) => l.provider).sort()).toEqual(['fitbit', 'oura']);

    // The eraser itself (its seam registration is pinned by
    // subject-erasure-feature-stores.test.ts — a full `eraseSubject` fan-out here
    // would run every feature's eraser against this file's bare persistence).
    await eraseWearableLinksForSubject(T, SUBJECT);
    expect(await listWearableLinksForSubject(T, SUBJECT)).toEqual([]);
    expect(await resolveSubjectForProviderUser(T, 'fitbit', 'fb-123')).toBeNull();
    expect(await resolveSubjectForProviderUser(T, 'oura', 'ou-9')).toBeNull();
    // Positive controls: the co-subject's and the other tenant's links survive.
    expect(await resolveSubjectForProviderUser(T, 'fitbit', 'fb-other')).toBe(OTHER);
    expect(await resolveSubjectForProviderUser(T2, 'fitbit', 'fb-123')).toBe(SUBJECT);
  });
});
