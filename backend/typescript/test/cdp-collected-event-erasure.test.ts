/**
 * CONS-6 — `cdp:collected-event` self-declares its PII and no DSAR reached it.
 *
 * `collectService` stores an untyped `payload` bag and TAGS THE PAYLOAD'S PII
 * KEYS AT INGEST (`piiFields`, via `looksLikePiiName`). It is the one store in
 * the app that says in its own row that it holds PII — and `features/cdp/`
 * registered ZERO `registerSubjectEraser` and zero resolvers. Its only lifecycle
 * was a retention purger that is opt-in and default-off, so on a default install
 * the rows were reachable by NOTHING.
 *
 * It is also invisible to the ADR 0464 feature gate by construction: the subject
 * identity lives inside `Record<string, unknown>`, which no field-name matcher
 * can bind (the assessment's "mechanism 8"). No ratchet was ever going to demand
 * this eraser, so both directions are pinned here instead:
 *
 *   REACH        — the subject's events are actually deleted, via an identity
 *                  field AND via an ingest-tagged PII field;
 *   NON-REACH    — a DIFFERENT subject's events survive, and a coincidental
 *                  substring does not match. Over-erasure is unrecoverable, and
 *                  it is the failure mode the `forms:submission` PARTIAL_COVERAGE
 *                  entry explicitly refuses to risk.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseCdpCollectedEvents } from '../src/features/cdp/erasure.js';

interface Row {
  eventId: string; tenantId: string; eventType: string;
  payload: Record<string, unknown>; piiFields: string[]; at: string;
}

const T = 'ws:cdp-erase';
let events: DurableCollection<Row>;

const put = async (eventId: string, payload: Record<string, unknown>, piiFields: string[] = [], tenantId = T): Promise<void> => {
  await events.put({ eventId, tenantId, eventType: 'pageview', payload, piiFields, at: new Date().toISOString() });
};
const ids = async (): Promise<string[]> => (await events.list()).map((r) => r.eventId).sort();

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  events = new DurableCollection<Row>('cdp:collected-event', (e) => e.eventId, undefined, (e) => e.tenantId);
});

describe('CONS-6 — the CDP ingest store is reachable by a DSAR', () => {
  it('REACH: deletes events addressed by an identity field or an ingest-tagged PII field', async () => {
    // An identity field that `looksLikePiiName` does NOT flag — which is exactly
    // why the ingest tag alone was never enough.
    await put('e-session', { sessionKey: 'sess-abc', path: '/pricing' });
    await put('e-contact', { contactId: 'crm:jane', path: '/checkout' });
    // …and one reachable only through the row's OWN ingest tag.
    await put('e-tagged', { email: 'jane@example.com', page: '/x' }, ['email']);
    await put('e-other', { sessionKey: 'sess-zzz', path: '/pricing' });

    await eraseCdpCollectedEvents(T, 'sess-abc');
    await eraseCdpCollectedEvents(T, 'crm:jane');
    await eraseCdpCollectedEvents(T, 'JANE@EXAMPLE.COM'); // case-folded

    expect(await ids()).toEqual(['e-other']);
  });

  it('NON-REACH: a different subject, a different tenant, and a substring coincidence all survive', async () => {
    await put('keep-other-subject', { sessionKey: 'sess-zzz' });
    await put('keep-substring', { sessionKey: 'sess-abc-extended' }); // superstring, not equal
    await put('keep-untagged-freetext', { note: 'sess-abc mentioned in a comment' }); // not an identity key, not tagged
    await put('keep-other-tenant', { sessionKey: 'sess-abc' }, [], 'ws:someone-else');

    await eraseCdpCollectedEvents(T, 'sess-abc');

    expect(await ids()).toEqual(['keep-other-subject', 'keep-other-tenant', 'keep-substring', 'keep-untagged-freetext'].sort());
  });

  it('is idempotent and no-ops on a falsy tenant or subject (never a global purge)', async () => {
    await put('e1', { sessionKey: 'sess-abc' });
    await eraseCdpCollectedEvents('', 'sess-abc');
    await eraseCdpCollectedEvents(T, '');
    await eraseCdpCollectedEvents(T, '   ');
    expect(await ids()).toEqual(['e1']);
    await eraseCdpCollectedEvents(T, 'sess-abc');
    expect(await ids()).toEqual([]);
    await eraseCdpCollectedEvents(T, 'sess-abc'); // idempotent: a re-run finds nothing and throws nothing
    expect(await ids()).toEqual([]);
  });
});
