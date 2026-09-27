/**
 * CRM-3 + CRM-4 — the two per-person controls that reported success while doing
 * the opposite of what their own prose claimed.
 *
 * CRM-3: `deleteContact` is deliberately ordered fail-closed — unindex FIRST, then
 * the row, then the lifecycle cascade — "so a hard delete can't leave a stale
 * identifier key pointing at a gone contact". The retention purger bypassed all
 * three by passing a raw `(id) => store.delete(id)`. So the one per-person PII
 * control CRM has RETAINED the exact field it exists to purge: a `cdp:contact-ident`
 * row whose KEY is `${tenantId}::email::<the address>` and whose value holds the
 * normalized email/phone survived every purge, and the 8 registered lifecycle
 * consumers never dropped their soft references.
 *
 * CRM-4: `isSuppressed` swallowed a storage error into `false` — "not suppressed" —
 * so the send PROCEEDED, while the file header, the function docstring and all
 * three egress call sites claimed fail-closed. `DurableCollection.get` returns
 * `null` for a missing row, so that `.catch` could only ever swallow a real read
 * failure. A transient KV outage emailed hard bounces and registered complainants.
 *
 * Both polarities are asserted in each case: the control must FIRE, and it must
 * not fire when it should not.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { createContact, deleteContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { resolveContactIdByIdentifier } from '../src/features/crm/contactIdentityService.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import {
  addSuppression, isSuppressed, suppressionBlocksSend, __clearSuppressions,
} from '../src/features/crm/suppressionService.js';
import { onCrmRecordDeleted } from '../src/host/crmRecordLifecycle.js';

const T = 'crm-pii-controls-tenant';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // createApp initializes host-ext persistence (the DurableCollection store).
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

describe('CRM-3 — the retention purger goes through deleteContact', () => {
  afterEach(async () => { await __resetCrmStore(); });

  it('purging a contact also drops its cdp:contact-ident rows — the email is not left in the KEY', async () => {
    const email = 'purge-me@acme.test';
    const contact = await createContact({
      tenantId: T, name: 'Purge Me', stage: 'lead', email,
      identifiers: [{ type: 'phone', value: '+1 (555) 010-2030', source: 'manual' }],
    });

    // Precondition — WITHOUT this the assertions below could pass vacuously on an
    // index that was never written in the first place.
    expect(await resolveContactIdByIdentifier(T, 'email', email)).toBe(contact.contactId);
    expect(await resolveContactIdByIdentifier(T, 'phone', '+15550102030')).toBe(contact.contactId);

    const results = await purgeRetained(T, 'confidential-pii', FUTURE);
    const crm = results.find((r) => r.feature === 'crm');
    expect(crm, 'the crm purger must be registered').toBeTruthy();
    expect(crm!.deleted, 'the contact row itself is purged').toBeGreaterThanOrEqual(1);

    // THE assertion. Before the fix these still resolved: the purger deleted the
    // contact row and left the identifier index — whose key IS the address —
    // permanently behind.
    expect(
      await resolveContactIdByIdentifier(T, 'email', email),
      'the identifier index must not outlive the contact it indexed',
    ).toBeNull();
    expect(await resolveContactIdByIdentifier(T, 'phone', '+15550102030')).toBeNull();
  });

  it('purging fires the CRM record-lifecycle cascade, so consumers drop their soft refs', async () => {
    const seen: Array<{ entity: string; recordId: string }> = [];
    onCrmRecordDeleted('crm-3-test-probe', async (e) => { seen.push({ entity: e.entity, recordId: e.recordId }); });

    const contact = await createContact({ tenantId: T, name: 'Cascade Me', stage: 'lead', email: 'cascade@acme.test' });
    await purgeRetained(T, 'confidential-pii', FUTURE);

    // Before the fix the raw collection delete skipped `fireCrmRecordDeleted`
    // entirely, so all 8 registered consumers kept pointing at a gone contact.
    expect(seen).toContainEqual({ entity: 'contact', recordId: contact.contactId });
  });

  it('a contact NEWER than the cutoff is retained — the purge still discriminates', async () => {
    // The refusal half. A purger that deleted everything would pass the two cases
    // above while being catastrophically wrong.
    const contact = await createContact({ tenantId: T, name: 'Too New', stage: 'lead', email: 'toonew@acme.test' });
    const results = await purgeRetained(T, 'confidential-pii', PAST);
    expect(results.find((r) => r.feature === 'crm')?.deleted).toBe(0);
    expect(await resolveContactIdByIdentifier(T, 'email', 'toonew@acme.test')).toBe(contact.contactId);
  });

  it('a non-PII classification is a no-op (fail-closed on the classification, unchanged)', async () => {
    await createContact({ tenantId: T, name: 'Keep', stage: 'lead', email: 'keep@acme.test' });
    const results = await purgeRetained(T, 'internal', FUTURE);
    expect(results.find((r) => r.feature === 'crm')?.deleted).toBe(0);
  });

  it('deleteContact itself is unchanged — the direct path already did this', async () => {
    const contact = await createContact({ tenantId: T, name: 'Direct', stage: 'lead', email: 'direct@acme.test' });
    expect(await deleteContact(contact.contactId)).toBe(true);
    expect(await resolveContactIdByIdentifier(T, 'email', 'direct@acme.test')).toBeNull();
  });
});

describe('CRM-4 — a suppression check that cannot read its store refuses the send', () => {
  afterEach(async () => {
    // Restore the real storage before clearing, or the clear itself would throw.
    const real = (globalThis as { __crmRealStorage?: Storage }).__crmRealStorage;
    if (real) { initHostExtPersistence(real); delete (globalThis as { __crmRealStorage?: Storage }).__crmRealStorage; }
    await __clearSuppressions();
  });

  /** Swap in a storage whose `kvGet` throws for the suppression namespace only —
   *  the shape of a transient KV read failure, not a whole-store outage. */
  function breakSuppressionReads(): void {
    const real = __hostExtStorage();
    if (!real) throw new Error('host-ext storage must be initialized');
    (globalThis as { __crmRealStorage?: Storage }).__crmRealStorage = real;
    const broken: Storage = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'kvGet') {
          return async (key: string): Promise<string | null> => {
            if (key.includes('crm:suppression')) throw new Error('simulated KV read failure');
            return (target as Storage).kvGet(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    initHostExtPersistence(broken);
  }

  it('a suppressed address blocks the send (the control fires at all)', async () => {
    await addSuppression(T, 'bounced@acme.test', 'bounced', 'webhook:test');
    expect(await suppressionBlocksSend(T, 'bounced@acme.test')).toBe('suppressed');
    expect(await suppressionBlocksSend(T, 'BOUNCED@ACME.TEST'), 'normalization still applies').toBe('suppressed');
  });

  it('an unsuppressed address does NOT block the send (the control discriminates)', async () => {
    expect(await suppressionBlocksSend(T, 'fine@acme.test')).toBe('clear');
  });

  it("another tenant's suppression does not block this tenant's send", async () => {
    await addSuppression('some-other-tenant', 'shared@acme.test', 'complaint', 'webhook:test');
    expect(await suppressionBlocksSend(T, 'shared@acme.test')).toBe('clear');
  });

  it('an unreadable store BLOCKS the send — this is the whole finding', async () => {
    // Before the fix: `.catch(() => undefined)` → false → "not suppressed" → the
    // send proceeds. A hard bounce or a registered complainant gets emailed
    // because a KV read blipped.
    breakSuppressionReads();
    const check = await suppressionBlocksSend(T, 'unknown-status@acme.test');
    expect(check, 'a suppression check that cannot read its store must refuse').not.toBe('clear');
    // FOLD-IN B5 — and the refusal must be DISTINGUISHABLE from a real suppression.
    // While this returned a bare boolean, every caller recorded the outage as
    // "this person asked us to stop": a durable, terminal, false consent claim that
    // also excluded them from the campaign generation permanently.
    expect(check, 'an outage is not a consent decision and must not be reported as one').toBe('unreadable');
  });

  it('the strict primitive PROPAGATES the error rather than reporting "not suppressed"', async () => {
    // The wrapper's fail-closed answer is only trustworthy because the primitive
    // beneath it stopped lying. Asserted separately: a wrapper that returned true
    // for everything would pass the case above while the primitive stayed broken.
    breakSuppressionReads();
    await expect(isSuppressed(T, 'unknown-status@acme.test')).rejects.toThrow(/simulated KV read failure/);
  });

  it('a malformed address is still the ONE fail-open case (nothing to key)', async () => {
    expect(await suppressionBlocksSend(T, '   ')).toBe('clear');
  });
});
