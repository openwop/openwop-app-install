/**
 * ADR 0462 Phase 1 — the wearable provider→subject link store. Pins:
 *  - fail-closed on `wearable-evidence` consent (can't link without opting in);
 *  - first-write-wins per (provider, providerUserId) — no hijack of a provider
 *    account to a second subject;
 *  - resolve (the webhook's reverse lookup) + ownership-checked unlink;
 *  - erasure (ADR 0381) drops the subject's links.
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

  it('unlink removes only the CALLER\'s own binding', async () => {
    await consent();
    await linkWearableProvider(T, SUBJECT, 'fitbit', 'fb-123');
    await unlinkWearableProvider(T, OTHER, 'fitbit', 'fb-123'); // not the owner ⇒ no-op
    expect(await resolveSubjectForProviderUser(T, 'fitbit', 'fb-123')).toBe(SUBJECT);
    await unlinkWearableProvider(T, SUBJECT, 'fitbit', 'fb-123'); // owner ⇒ removed
    expect(await resolveSubjectForProviderUser(T, 'fitbit', 'fb-123')).toBeNull();
  });

  it('lists the subject\'s links; erasure drops them (ADR 0381)', async () => {
    await consent();
    await linkWearableProvider(T, SUBJECT, 'fitbit', 'fb-123');
    await linkWearableProvider(T, SUBJECT, 'oura', 'ou-9');
    expect((await listWearableLinksForSubject(T, SUBJECT)).map((l) => l.provider).sort()).toEqual(['fitbit', 'oura']);
    await eraseWearableLinksForSubject(T, SUBJECT);
    expect(await listWearableLinksForSubject(T, SUBJECT)).toEqual([]);
    expect(await resolveSubjectForProviderUser(T, 'fitbit', 'fb-123')).toBeNull();
  });
});
