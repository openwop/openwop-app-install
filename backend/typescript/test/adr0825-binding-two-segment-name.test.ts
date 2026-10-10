/**
 * ADR 0825 / RFC 0236 — a host-event BINDING named with the two-segment
 * `hostEvents` type (`openwop-app.crm-contact-created`) fires.
 *
 * The binding route accepts that spelling (`isV2HostEventName` allows one or
 * two segments after the org), but the dispatcher matched only the in-process
 * name and the ADR 0792 three-segment projection, so the binding was stored and
 * then silently never started its workflow. Bindings are host-extension state,
 * not wire, so the match does not depend on OPENWOP_HOST_EVENTS_V2.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createHostEventBinding,
  emitHostEvent,
  initHostEventDispatcher,
  __clearHostEventBindings,
  __resetHostEventDispatcher,
} from '../src/host/hostEventDispatcher.js';
import { hostEventEntryForEmitted } from '../src/host/hostEventTypes.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let fired: string[];

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __clearHostEventBindings();
  fired = [];
  initHostEventDispatcher({
    storage,
    hostSuite,
    deliverWebhooks: async () => {},
    startRun: async (_deps, input) => {
      fired.push(input.workflowId);
      return `run:${input.workflowId}`;
    },
  });
});

afterEach(() => {
  __resetHostEventDispatcher();
  __resetHostExtPersistence();
});

describe('host-event binding by its two-segment RFC 0236 type (ADR 0825)', () => {
  const emitted = 'host.crm.contact.created';
  const payload = { entityType: 'contact', entityId: 'crm:1' };

  it('the catalog really maps the emitted name to the two-segment type (non-vacuity)', () => {
    expect(hostEventEntryForEmitted(emitted)?.type).toBe('openwop-app.crm-contact-created');
  });

  it('a binding on openwop-app.crm-contact-created starts its workflow', async () => {
    await createHostEventBinding({ tenantId: 't-2seg', eventType: 'openwop-app.crm-contact-created', workflowId: 'wf:two-seg', createdBy: 'test' });
    await emitHostEvent({ type: emitted, tenantId: 't-2seg', payload });
    expect(fired).toEqual(['wf:two-seg']);
  });

  it('the older spellings still fire, once each (control)', async () => {
    await createHostEventBinding({ tenantId: 't-old', eventType: emitted, workflowId: 'wf:in-process', createdBy: 'test' });
    await createHostEventBinding({ tenantId: 't-old', eventType: 'openwop-app.crm.contact-created', workflowId: 'wf:three-seg', createdBy: 'test' });
    await emitHostEvent({ type: emitted, tenantId: 't-old', payload });
    expect(fired.sort()).toEqual(['wf:in-process', 'wf:three-seg']);
  });

  it('a two-segment name of a DIFFERENT event does not fire (negative)', async () => {
    await createHostEventBinding({ tenantId: 't-neg', eventType: 'openwop-app.crm-contact-updated', workflowId: 'wf:other', createdBy: 'test' });
    await emitHostEvent({ type: emitted, tenantId: 't-neg', payload });
    expect(fired).toEqual([]);
  });
});
