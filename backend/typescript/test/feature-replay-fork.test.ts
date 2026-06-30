/**
 * Feature-variant replay/fork safety (ADR 0001 §3.4/§3.5 — the CRITICAL
 * invariant of the whole design).
 *
 * Proves, end-to-end:
 *   1. A triage run stamps the resolved variant + bindings into run.metadata.
 *   2. Pack presence is DECOUPLED from toggle state — featurePackRefs() includes
 *      feature.crm.nodes whether CRM is on or off (packs stay loaded so a
 *      historical run can always replay).
 *   3. After the CRM toggle is flipped OFF, forking the run still reads the
 *      SAME stamped variant + bindings VERBATIM — the variant is carried, never
 *      recomputed. (If it were recomputed, an off toggle would yield no variant
 *      and break fork/replay.)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { featurePackRefs } from '../src/features/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetCrmStore } from '../src/features/crm/contactsService.js';

describe('feature variant — replay/fork safety', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  let workflowId: string;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    await __clearToggleStore();
    await __resetCrmStore();
    await new Promise<void>((res) => {
      server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
    // A real catalog workflow id — fork 404s on an unknown workflow.
    const disco = await jf<{ fixtures?: string[] }>('/.well-known/openwop');
    workflowId = disco.body.fixtures?.[0] ?? 'openwop-app.uppercase';
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string> ?? {}) },
    });
    const raw = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: raw as T };
  }

  async function setCrm(status: 'on' | 'off'): Promise<void> {
    const r = await jf('/v1/host/openwop-app/feature-toggles/admin/configs/crm', {
      method: 'PUT',
      body: JSON.stringify({
        status,
        bucketUnit: 'tenant',
        salt: 'crm',
        variants: [
          { key: 'basic', weight: 50, bindings: [{ slot: 'crm.triage', ref: { kind: 'node', name: 'feature.crm.nodes.triage', version: '1.0.0' } }] },
          { key: 'enriched', weight: 50, bindings: [{ slot: 'crm.triage', ref: { kind: 'node', name: 'feature.crm.nodes.triage-enriched', version: '1.0.0' } }] },
        ],
      }),
    });
    expect(r.status).toBe(200);
  }

  it('pack presence is decoupled from toggle state', async () => {
    // featurePackRefs() is the boot install set — static across toggle state.
    const hasCrmPack = () => featurePackRefs().some((p) => p.name === 'feature.crm.nodes');
    await setCrm('on');
    expect(hasCrmPack()).toBe(true);
    await setCrm('off');
    expect(hasCrmPack()).toBe(true); // still present when the feature is OFF
  });

  it('forking after the toggle is flipped off reads the stamped variant verbatim', async () => {
    await setCrm('on');

    // Triage a contact against a real workflow so the run is forkable.
    const contact = await jf<{ contactId: string }>('/v1/host/openwop-app/crm/contacts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Katherine Johnson', company: 'NASA', stage: 'customer' }),
    });
    const triage = await jf<{ runId: string; variant: string | null }>(
      `/v1/host/openwop-app/crm/contacts/${contact.body.contactId}/triage`,
      { method: 'POST', body: JSON.stringify({ workflowId }) },
    );
    expect(triage.status).toBe(202);
    const sourceRunId = triage.body.runId;

    // Read the source stamp.
    const source = await jf<{ featureVariant?: { variant?: string; bindings?: unknown } }>(`/v1/host/openwop-app/crm/runs/${sourceRunId}`);
    const sourceVariant = source.body.featureVariant?.variant;
    expect(['basic', 'enriched']).toContain(sourceVariant);

    // ── Flip CRM OFF ──
    await setCrm('off');
    // The live feature surface is now gone…
    expect((await jf(`/v1/host/openwop-app/crm/contacts`)).status).toBe(404);
    // …but the historical run's provenance is still readable (ungated).
    const sourceAfterOff = await jf<{ featureVariant?: { variant?: string } }>(`/v1/host/openwop-app/crm/runs/${sourceRunId}`);
    expect(sourceAfterOff.body.featureVariant?.variant).toBe(sourceVariant);

    // ── Fork the run (core endpoint, not toggle-gated) ──
    const fork = await jf<{ runId: string }>(`/v1/runs/${sourceRunId}:fork`, {
      method: 'POST',
      body: JSON.stringify({ fromSeq: 0, mode: 'replay' }),
    });
    expect(fork.status).toBe(201);

    // ── The forked run carries the SAME stamp, VERBATIM (not recomputed) ──
    const forked = await jf<{ featureVariant?: { variant?: string; feature?: string; bindings?: unknown } }>(
      `/v1/host/openwop-app/crm/runs/${fork.body.runId}`,
    );
    expect(forked.body.featureVariant?.feature).toBe('crm');
    expect(forked.body.featureVariant?.variant).toBe(sourceVariant);
    expect(forked.body.featureVariant?.bindings).toEqual(source.body.featureVariant?.bindings);
  });
});
