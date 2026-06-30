/**
 * CRM feature end-to-end (ADR 0001 §4 / §6 Phase 4).
 *
 * Covers the feature-package contract on a real app:
 *   - Toggle-gating (backend authority): the surface 404s when `crm` is off,
 *     works when on, 404s again when flipped off.
 *   - Contacts CRUD, tenant-scoped.
 *   - Triage stamps the resolved variant + bindings into run.metadata
 *     (the replay-safe home — verified to round-trip via GET /v1/runs/{id}).
 *   - The feature.crm.nodes pack is well-formed (namespace + node map).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetCrmStore } from '../src/features/crm/contactsService.js';

const PACK_DIR = join(__dirname, '..', '..', '..', 'packs', 'feature.crm.nodes');

describe('CRM feature (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token'; // wildcard bearer ⇒ superadmin
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
    // A real catalog workflow — triage 422s on an unresolvable workflow.
    workflowId = (await jf<{ fixtures?: string[] }>('/.well-known/openwop')).body.fixtures?.[0] ?? 'openwop-app.uppercase';
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

  it('the surface 404s while CRM is off (backend authority)', async () => {
    const r = await jf('/v1/host/openwop-app/crm/contacts');
    expect(r.status).toBe(404);
  });

  it('contacts CRUD works once CRM is enabled', async () => {
    await setCrm('on');
    const created = await jf<{ contactId: string; name: string; stage: string }>('/v1/host/openwop-app/crm/contacts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada Lovelace', company: 'Analytical Engines', stage: 'qualified' }),
    });
    expect(created.status).toBe(201);
    expect(created.body.contactId.startsWith('crm:')).toBe(true);

    const list = await jf<{ contacts: { contactId: string }[] }>('/v1/host/openwop-app/crm/contacts');
    expect(list.body.contacts.some((c) => c.contactId === created.body.contactId)).toBe(true);
  });

  it('triage stamps the resolved variant + bindings into run.metadata (round-trips)', async () => {
    await setCrm('on');
    const contact = await jf<{ contactId: string }>('/v1/host/openwop-app/crm/contacts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Grace Hopper', company: 'Navy', stage: 'customer' }),
    });
    const triage = await jf<{ runId: string; variant: string | null; bindings: unknown }>(
      `/v1/host/openwop-app/crm/contacts/${contact.body.contactId}/triage`,
      { method: 'POST', body: JSON.stringify({ workflowId }) },
    );
    expect(triage.status).toBe(202);
    expect(['basic', 'enriched']).toContain(triage.body.variant);
    expect(triage.body.bindings).not.toBeNull();

    // The stamp lives in host-internal run.metadata (off the normative wire);
    // read it via the CRM provenance endpoint.
    const stamp = await jf<{ featureVariant?: { feature?: string; variant?: string }; crm?: { contactId?: string } }>(
      `/v1/host/openwop-app/crm/runs/${triage.body.runId}`,
    );
    expect(stamp.status).toBe(200);
    expect(stamp.body.featureVariant?.feature).toBe('crm');
    expect(stamp.body.featureVariant?.variant).toBe(triage.body.variant);
    expect(stamp.body.crm?.contactId).toBe(contact.body.contactId);
  });

  it('flipping CRM off makes the surface 404 again', async () => {
    await setCrm('off');
    const r = await jf('/v1/host/openwop-app/crm/contacts');
    expect(r.status).toBe(404);
  });
});

describe('feature.crm.nodes pack', () => {
  it('pack.json is well-formed and node typeIds match the pack namespace', () => {
    const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as {
      name: string;
      version: string;
      engines: { openwop: string };
      runtime: { language: string; entry: string };
      nodes: { typeId: string; version: string; category: string; role: string }[];
    };
    expect(manifest.name).toBe('feature.crm.nodes');
    expect(manifest.engines.openwop).toBeTruthy();
    expect(manifest.runtime.entry).toBe('./index.mjs');
    expect(manifest.nodes.length).toBeGreaterThan(0);
    for (const n of manifest.nodes) {
      expect(n.typeId.startsWith('feature.crm.nodes')).toBe(true); // RFC 0003 §B namespace
      expect(n.category).toBeTruthy();
      expect(n.role).toBeTruthy();
    }
  });

  it('index.mjs exports a nodes map whose functions return success', async () => {
    const mod = (await import(pathToFileURL(join(PACK_DIR, 'index.mjs')).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: unknown }>>;
    };
    expect(typeof mod.nodes['feature.crm.nodes.triage']).toBe('function');
    expect(typeof mod.nodes['feature.crm.nodes.triage-enriched']).toBe('function');
    const out = await mod.nodes['feature.crm.nodes.triage']!({ inputs: { contact: { stage: 'customer' } } });
    expect(out.status).toBe('success');
  });
});
