/**
 * Host-event payload PII stripping (CRMGAP-16 — ADR 0208 §1 correction,
 * 2026-07-03). `emitHostEvent` (host/hostEventDispatcher.ts) strips
 * unambiguous person-PII keys (`email`, `phone`, any key ENDING `Email`/
 * `Phone`) from the payload before EITHER fanout — the webhook delivery body
 * AND the `metadata.triggerData.payload` a matched binding's run gets stamped
 * with. A non-person artifact's `name` field (a brief title, a template
 * name, …) is explicitly NOT stripped — it's the enforceable rule the ADR
 * 0208 §1 correction landed on ("no person-PII fields", not "ids only").
 *
 * Unit-style: fakes for both fanout deps (no real webhook delivery / run
 * execution), a real storage for the durable binding registry + the
 * autonomous-run budget counter `emitHostEvent` also touches.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createHostEventBinding,
  emitHostEvent,
  initHostEventDispatcher,
  __clearHostEventBindings,
  __resetHostEventDispatcher,
  type HostEventEnvelope,
} from '../src/host/hostEventDispatcher.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let storage: Storage;
let delivered: HostEventEnvelope[];
let startRunCalls: Array<{ tenantId: string; workflowId: string; metadata?: Record<string, unknown> }>;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __clearHostEventBindings();
  delivered = [];
  startRunCalls = [];
  initHostEventDispatcher({
    storage,
    hostSuite,
    deliverWebhooks: async (event) => {
      delivered.push(event);
    },
    startRun: async (_deps, input) => {
      startRunCalls.push(input);
      return 'run:fake-1';
    },
  });
});

afterEach(() => {
  __resetHostEventDispatcher();
  __resetHostExtPersistence();
});

describe('emitHostEvent — CRMGAP-16 payload PII stripping', () => {
  it('strips email/phone/*Email/*Phone keys from BOTH the webhook payload and the triggered run\'s triggerData payload; a non-person `name` survives', async () => {
    const tenantId = 'tenant-pii-1';
    await createHostEventBinding({ tenantId, eventType: 'host.crm.contact.created', workflowId: 'wf:test', createdBy: 'test' });

    await emitHostEvent({
      type: 'host.crm.contact.created',
      tenantId,
      payload: {
        entityType: 'contact',
        entityId: 'crm:abc123',
        email: 'leak@example.com',
        contactEmail: 'leak2@example.com',
        phone: '555-0100',
        billingPhone: '555-0101',
        name: 'Q3 Enterprise Brief', // non-person artifact name — NOT stripped
        changed: ['stage'],
      },
    });

    // Webhook fanout: exactly one delivery, PII-free.
    expect(delivered).toHaveLength(1);
    const webhookPayload = delivered[0]!.payload;
    expect(webhookPayload).not.toHaveProperty('email');
    expect(webhookPayload).not.toHaveProperty('contactEmail');
    expect(webhookPayload).not.toHaveProperty('phone');
    expect(webhookPayload).not.toHaveProperty('billingPhone');
    expect(webhookPayload.entityType).toBe('contact');
    expect(webhookPayload.entityId).toBe('crm:abc123');
    expect(webhookPayload.name).toBe('Q3 Enterprise Brief'); // allowed — not person-PII
    expect(webhookPayload.changed).toEqual(['stage']);

    // Triggered run: the SAME stripped payload, not a second unstripped copy.
    expect(startRunCalls).toHaveLength(1);
    const triggerData = startRunCalls[0]!.metadata?.triggerData as { eventName: string; payload: Record<string, unknown> };
    expect(triggerData.eventName).toBe('host.crm.contact.created');
    expect(triggerData.payload).not.toHaveProperty('email');
    expect(triggerData.payload).not.toHaveProperty('contactEmail');
    expect(triggerData.payload).not.toHaveProperty('phone');
    expect(triggerData.payload).not.toHaveProperty('billingPhone');
    expect(triggerData.payload.name).toBe('Q3 Enterprise Brief');
  });

  it('a payload with no PII-marker keys passes through unchanged', async () => {
    const tenantId = 'tenant-pii-2';
    await emitHostEvent({
      type: 'host.crm.deal.stage-changed',
      tenantId,
      payload: { entityType: 'deal', entityId: 'deal:1', orgId: 'org:1' },
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toEqual({ entityType: 'deal', entityId: 'deal:1', orgId: 'org:1' });
  });
});
