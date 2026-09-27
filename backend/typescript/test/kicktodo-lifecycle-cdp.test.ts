/**
 * ADR 0456 P1 — KickTodo lifecycle → CDP collect seam. Pins the two invariants:
 *  - CONSENT GATE: no linked CRM Contact ⇒ NO event (the D3 privacy floor);
 *  - PII BOUNDARY: the opaque subject NEVER enters the payload — only the opaque
 *    contactId + non-PII props; and the emit is deterministic (dedupe).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { emitKicktodoLifecycle } from '../src/features/kicktodo-core/lifecycleEvents.js';
import { linkSubjectToContact, __resetContactBridge } from '../src/features/kicktodo-core/contactBridgeService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { listCollectedEvents } from '../src/features/cdp/collectService.js';

const T = 'tenant-lc';
const SUBJECT = 'user:participant-lc';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetContactBridge();
});

describe('emitKicktodoLifecycle (ADR 0456 P1)', () => {
  it('suppresses the event when the subject has NO linked Contact (Gate 0)', async () => {
    const emitted = await emitKicktodoLifecycle(T, SUBJECT, 'enrolled', { challengeId: 'c1', challengeVersion: 1 });
    expect(emitted).toBe(false);
    expect(await listCollectedEvents(T)).toHaveLength(0); // nothing collected
  });

  it('emits keyed to the contactId when a Contact is linked; opaque subject never in the payload', async () => {
    const contact = await createContact({ tenantId: T, name: 'Pat', email: 'pat@x.test' });
    await linkSubjectToContact(T, SUBJECT, contact.contactId, 'paid-checkout');

    const emitted = await emitKicktodoLifecycle(T, SUBJECT, 'completed', { challengeId: 'c1', challengeVersion: 2 });
    expect(emitted).toBe(true);

    const events = await listCollectedEvents(T);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('kicktodo.participant.completed');
    expect(events[0].payload.contactId).toBe(contact.contactId);
    expect(events[0].payload.challengeId).toBe('c1');
    expect(events[0].payload.challengeVersion).toBe(2);
    // PII boundary: the opaque subject is NOWHERE in the payload.
    expect(JSON.stringify(events[0].payload)).not.toContain(SUBJECT);
    expect(events[0].payload.ownerSubject).toBeUndefined();
    expect(events[0].payload.email).toBeUndefined();
  });

  it('is deterministic per transition — a replay never double-counts', async () => {
    const contact = await createContact({ tenantId: T, name: 'Sam', email: 'sam@x.test' });
    await linkSubjectToContact(T, SUBJECT, contact.contactId, 'reminder-consent');

    await emitKicktodoLifecycle(T, SUBJECT, 'enrolled', { challengeId: 'c9', challengeVersion: 1 });
    await emitKicktodoLifecycle(T, SUBJECT, 'enrolled', { challengeId: 'c9', challengeVersion: 1 }); // retry
    expect(await listCollectedEvents(T)).toHaveLength(1); // same dedupeKey ⇒ one row

    // A DIFFERENT transition (different event) is a distinct row.
    await emitKicktodoLifecycle(T, SUBJECT, 'completed', { challengeId: 'c9', challengeVersion: 1 });
    expect(await listCollectedEvents(T)).toHaveLength(2);
  });
});
