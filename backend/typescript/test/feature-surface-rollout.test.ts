/**
 * ADR 0014 Phase 4 — the pattern generalizes + is advertised.
 *   1. A SECOND feature surface (ctx.features.crm) reads org-scoped CRM data and
 *      holds tenant isolation (CTI-1) — proving the FeatureModule contract isn't
 *      KB-specific.
 *   2. Discovery advertises the live feature surfaces at the document root
 *      (host.sample.<id>), so a client/pack can discover them (honesty principle).
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { createCompany } from '../src/features/crm/crmEntitiesService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;

const setCrm = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('crm'); if (d) await saveConfig({ ...d, status }, 'test'); };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  await setCrm('on'); // surfaces are toggle-gated — a node reads CRM only when enabled
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const crmSurface = (tenantId: string) => buildHostSurfaceBundle({ tenantId }).features.crm!;

describe('ctx.features.crm — the second reference surface', () => {
  it('reads org-scoped CRM data', async () => {
    const tenantId = 'crm-surf-tenant';
    const orgId = 'org-1';
    await createCompany({ tenantId, orgId, name: 'Acme Inc', createdBy: 'actor' });

    const crm = crmSurface(tenantId);
    const out = await crm.listCompanies!({ orgId });
    const companies = out.companies as Array<{ name: string }>;
    expect(companies.some((c) => c.name === 'Acme Inc')).toBe(true);
  });

  it('enforces tenant isolation (CTI-1): another tenant sees no companies', async () => {
    const tenantId = 'crm-owner-tenant';
    const orgId = 'org-x';
    await createCompany({ tenantId, orgId, name: 'Private Co', createdBy: 'actor' });

    const intruder = crmSurface('crm-other-tenant');
    const out = await intruder.listCompanies!({ orgId }); // same orgId string, different tenant
    expect((out.companies as unknown[]).length).toBe(0);
  });

  it('does not leak internal fields (tenantId / createdBy) into the surface output', async () => {
    const tenantId = 'crm-proj-tenant';
    await createCompany({ tenantId, orgId: 'org-1', name: 'Projected Co', createdBy: 'alice' });
    const out = await crmSurface(tenantId).listCompanies!({ orgId: 'org-1' });
    const company = (out.companies as Array<Record<string, unknown>>)[0]!;
    expect(company.name).toBe('Projected Co');
    expect(company.tenantId).toBeUndefined();
    expect(company.orgId).toBeUndefined();
    expect(company.createdBy).toBeUndefined();
  });

  it('refuses the surface when the feature toggle is OFF for the tenant', async () => {
    await setCrm('off');
    try {
      await expect(crmSurface('crm-surf-tenant').listCompanies!({ orgId: 'org-1' }))
        .rejects.toMatchObject({ code: 'host_capability_disabled', capability: 'host.sample.crm' });
    } finally {
      await setCrm('on');
    }
  });
});

describe('the feature-surface registry', () => {
  it('lists the composed surfaces', async () => {
    // ADR 0812 P4: this read `hostExtensions.featureSurfaces` from the v1
    // builder, which is deleted; the v2 root has no record for it (ADR 0858
    // ledger). The registry the advert was printed from is asserted instead.
    const { registeredFeatureSurfaceIds } = await import('../src/host/featureSurfaces.js');
    expect(registeredFeatureSurfaceIds()).toEqual(expect.arrayContaining(['kb', 'crm']));
  });
});

