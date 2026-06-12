/**
 * Forms extension surface (ADR 0014) — ctx.features.forms + feature.forms.nodes.
 * Service-level: the surface projects out internal columns and tenant/org-isolates;
 * the node pack runs read-only over a stub ctx.features.forms. (The REST + public
 * faces are covered by forms-route.test.ts.)
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __resetFormsStore, createForm, recordSubmission, type FormDef } from '../src/features/forms/formsService.js';
import { buildFormsSurface } from '../src/features/forms/surface.js';

const mkForm = (tenantId: string, orgId: string): Promise<FormDef> =>
  createForm({ tenantId, orgId, title: 'Contact', fields: [{ key: 'name', label: 'Name', type: 'text', required: false }], createdBy: 'u1' });

describe('Forms extension surface (ADR 0014 — ctx.features.forms + nodes)', () => {
  beforeAll(async () => {
    // boot createApp once to initialize host-ext persistence (the
    // DurableCollection backend) — no listen needed for these service-level tests.
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await createApp({ port: 18799, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  });
  beforeEach(async () => { await __resetFormsStore(); });

  it('listForms projects out internal columns + tenant-isolates', async () => {
    const a = await mkForm('t1', 'o1');
    await mkForm('t2', 'o1'); // different tenant, same orgId string
    const { forms } = (await buildFormsSurface({ tenantId: 't1' }).listForms({ orgId: 'o1' })) as { forms: Record<string, unknown>[] };
    expect(forms).toHaveLength(1);
    expect(forms[0].formId).toBe(a.formId);
    expect(forms[0].tenantId).toBeUndefined(); // projected out
    expect(forms[0].createdBy).toBeUndefined(); // projected out
  });

  it('getSubmissions tenant+org-guards + projects', async () => {
    const a = await mkForm('t1', 'o1');
    await recordSubmission(a, { name: 'Lead' }, {});
    const ok = (await buildFormsSurface({ tenantId: 't1' }).getSubmissions({ orgId: 'o1', formId: a.formId })) as { submissions: Record<string, unknown>[] };
    expect(ok.submissions).toHaveLength(1);
    expect(ok.submissions[0].tenantId).toBeUndefined();
    expect(ok.submissions[0].values).toMatchObject({ name: 'Lead' });
    // a cross-tenant surface sees nothing (CTI-1)
    const other = (await buildFormsSurface({ tenantId: 't2' }).getSubmissions({ orgId: 'o1', formId: a.formId })) as { submissions: unknown[] };
    expect(other.submissions).toHaveLength(0);
  });

  it('feature.forms.nodes run read-only over a stub ctx.features.forms', async () => {
    const a = await mkForm('t1', 'o1');
    await recordSubmission(a, { name: 'Lead' }, {});
    const mod = await import('../../../packs/feature.forms.nodes/index.mjs');
    const surf = buildFormsSurface({ tenantId: 't1' });
    const ctx = (inputs: Record<string, unknown>) => ({ features: { forms: surf }, inputs });
    const lf = await mod.nodes['feature.forms.nodes.list-forms'](ctx({ orgId: 'o1' }));
    expect(lf.status).toBe('success');
    expect((lf.outputs as { forms: unknown[] }).forms).toHaveLength(1);
    const ls = await mod.nodes['feature.forms.nodes.list-submissions'](ctx({ orgId: 'o1', formId: a.formId }));
    expect(ls.status).toBe('success');
    expect((ls.outputs as { submissions: unknown[] }).submissions).toHaveLength(1);
  });
});
