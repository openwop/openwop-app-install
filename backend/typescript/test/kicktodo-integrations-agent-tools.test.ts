/**
 * chat-first-port G5 — kicktodo-integrations chat-reachability + calendar-sync ignition.
 *
 *  (a) `openwop:kicktodo.integrations-status` READ tool: registered into the
 *      builtin surface, fails EMPTY without an acting user, honest-empty when the
 *      toggle is off, and reports the ACTING USER's OWN consents + wearable links
 *      + the deployment's calendar-transport readiness when enabled.
 *  (b) the calendar-write lane is now IGNITABLE: the `openwop-app.kicktodo.calendar-sync`
 *      builtin is registered, and the opt-in schedule binding arms a per-enrollment
 *      job — but only behind the gates (owner + live `calendar-write` consent +
 *      a configured transport), so nothing syncs by default.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import { listJobs } from '../src/host/schedulingService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { KICKTODO_INTEGRATIONS_STATUS_TOOL_ID } from '../src/features/kicktodo-integrations/agentTools.js';
import { KICKTODO_CALENDAR_SYNC_WORKFLOW_ID } from '../src/features/kicktodo-integrations/builtinWorkflows.js';
import { setCalendarSyncEnabled, calendarSyncJobId } from '../src/features/kicktodo-integrations/calendarSyncService.js';
import {
  registerCalendarTransport,
  __clearCalendarTransport,
} from '../src/features/kicktodo-integrations/calendarWriteService.js';
import { grantConsent, ConsentRequiredError } from '../src/features/kicktodo-integrations/integrationService.js';
import { CalendarUnavailableError } from '../src/features/kicktodo-integrations/calendarWriteService.js';
import { linkWearableProvider } from '../src/features/kicktodo-integrations/wearableLinkService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';

const TENANT = 'default';
const OWNER = 'user:g5-owner';
const OTHER = 'user:g5-other';

let server: http.Server;
let enrollmentId = '';

const setIntegrations = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('kicktodo-integrations');
  if (d) await saveConfig({ ...d, status }, 'test');
};

const status = (scope: { actingUserId?: string } = {}) =>
  createAgentToolProvider({ tenantId: TENANT, ...scope }).executeTool({ name: KICKTODO_INTEGRATIONS_STATUS_TOOL_ID, input: {} });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  __clearEnrollGuards();
  __clearCalendarTransport();
  const draft = await createDraft({
    tenantId: TENANT, title: 'G5 Challenge', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'walk', day: 1, title: 'Walk', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(TENANT, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: TENANT, ownerSubject: OWNER, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  enrollmentId = enrollment.id;
});

afterAll(async () => { __clearCalendarTransport(); await new Promise<void>((res) => server.close(() => res())); });

describe('G5(b) — the calendar-write lane is now ignitable', () => {
  it('registers the calendar-sync workflow chain-backed (composes the shared calendar-sync node)', () => {
    // ADR 0472 P4: calendar-sync migrated out of the builtin quarantine to a chain
    // pack keyed on the same id; it now resolves through the chain-backed registry.
    const wf = getChainBackedWorkflow(KICKTODO_CALENDAR_SYNC_WORKFLOW_ID);
    expect(wf).toBeTruthy();
    expect(wf?.nodes.map((n: { typeId: string }) => n.typeId)).toEqual(['feature.kicktodo.nodes.calendar-sync']);
  });
});

describe('G5(a) — openwop:kicktodo.integrations-status read tool', () => {
  it('registers into the builtin agent-tool surface', () => {
    expect(builtinAgentToolIds()).toContain(KICKTODO_INTEGRATIONS_STATUS_TOOL_ID);
  });

  it('fails EMPTY without an acting user (never enumerates a subject from a system turn)', async () => {
    await setIntegrations('on');
    const out = await status();
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ enabled: false, consents: [], wearableLinks: [] });
  });

  it('is honest-empty when the toggle is off', async () => {
    await setIntegrations('off');
    const out = await status({ actingUserId: OWNER });
    expect(JSON.parse(out.content)).toMatchObject({ enabled: false, consents: [], wearableLinks: [] });
    await setIntegrations('on');
  });

  it("reports the acting user's OWN consents, wearable links, and transport readiness", async () => {
    await setIntegrations('on');
    await grantConsent(TENANT, OWNER, 'calendar-write');
    await grantConsent(TENANT, OWNER, 'wearable-evidence');
    await linkWearableProvider(TENANT, OWNER, 'fitbit', 'fitbit-user-1');

    const out = await status({ actingUserId: OWNER });
    const body = JSON.parse(out.content) as {
      enabled: boolean;
      consents: { kind: string; consented: boolean }[];
      wearableLinks: { provider: string }[];
      calendarTransportConfigured: boolean;
    };
    expect(body.enabled).toBe(true);
    expect(body.consents.find((c) => c.kind === 'calendar-write')?.consented).toBe(true);
    expect(body.consents.find((c) => c.kind === 'wearable-evidence')?.consented).toBe(true);
    expect(body.consents.find((c) => c.kind === 'messaging-reminders')?.consented).toBe(false);
    expect(body.wearableLinks).toEqual([{ provider: 'fitbit', linkedAt: expect.any(String) }]);
    expect(body.calendarTransportConfigured).toBe(false); // no transport wired (lane ships gated-off)
  });

  it('never leaks ANOTHER subject: the acting user sees only their own (empty) state', async () => {
    const out = await status({ actingUserId: OTHER });
    const body = JSON.parse(out.content) as { consents: { consented: boolean }[]; wearableLinks: unknown[] };
    expect(body.consents.every((c) => c.consented === false)).toBe(true);
    expect(body.wearableLinks).toEqual([]);
  });
});

describe('G5(a) — calendar-sync schedule binding is opt-in and multiply gated', () => {
  it('a foreign / missing enrollment cannot be armed (owner-gated)', async () => {
    expect(await setCalendarSyncEnabled(TENANT, enrollmentId, OTHER, true)).toBe(false);
    expect(await setCalendarSyncEnabled(TENANT, 'nope', OWNER, true)).toBe(false);
  });

  it('arming without a live calendar-write consent fails closed', async () => {
    // Fresh enrollment owner without the consent.
    const draft = await createDraft({
      tenantId: TENANT, title: 'G5 NC', summary: 's', outcome: 'o', durationDays: 1,
      activities: [{ stableActivityId: 'a', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(TENANT, draft.id, 1);
    const { enrollment } = await enroll({ tenantId: TENANT, ownerSubject: OTHER, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
    await expect(setCalendarSyncEnabled(TENANT, enrollment.id, OTHER, true)).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('with consent but NO transport, arming fails closed (lane ships gated-off)', async () => {
    // OWNER already granted calendar-write above; no transport is registered.
    __clearCalendarTransport();
    await expect(setCalendarSyncEnabled(TENANT, enrollmentId, OWNER, true)).rejects.toBeInstanceOf(CalendarUnavailableError);
  });

  it('with consent AND a transport, arming registers the per-enrollment daily job; disable flips it off', async () => {
    registerCalendarTransport({ upsert: async () => {}, remove: async () => {} });
    expect(await setCalendarSyncEnabled(TENANT, enrollmentId, OWNER, true)).toBe(true);

    const jobId = calendarSyncJobId(TENANT, enrollmentId);
    const armed = (await listJobs(TENANT)).find((j) => j.jobId === jobId);
    expect(armed?.enabled).toBe(true);
    expect(armed?.workflowId).toBe(KICKTODO_CALENDAR_SYNC_WORKFLOW_ID);
    expect(armed?.inputs).toMatchObject({ enrollmentId, ownerSubject: OWNER });

    expect(await setCalendarSyncEnabled(TENANT, enrollmentId, OWNER, false)).toBe(true);
    const disabled = (await listJobs(TENANT)).find((j) => j.jobId === jobId);
    expect(disabled?.enabled).toBe(false);
    __clearCalendarTransport();
  });
});
