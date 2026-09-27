/**
 * Forms extension surface (ADR 0014) — ctx.features.forms + feature.forms.nodes.
 * Service-level: the surface projects out internal columns and tenant/org-isolates;
 * the node pack runs read-only over a stub ctx.features.forms. (The REST + public
 * faces are covered by forms-route.test.ts.)
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __resetFormsStore, createForm, updateForm, recordSubmission, type FormDef } from '../src/features/forms/formsService.js';
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

  // ADR 0246 (STRAT-PORTAL) — the forms→priority-matrix intake bridge.
  it('createForm/updateForm validate the intake binding against the form fields', async () => {
    const f = await createForm({
      tenantId: 't1', orgId: 'o1', title: 'Request', createdBy: 'u1',
      fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }, { key: 'detail', label: 'Detail', type: 'textarea', required: false }],
      intakeBinding: { listId: 'list:abc', titleField: 'summary', notesField: 'detail' },
    });
    expect(f.intakeBinding).toEqual({ listId: 'list:abc', titleField: 'summary', notesField: 'detail' });
    // A titleField that names no form field is rejected.
    await expect(createForm({
      tenantId: 't1', orgId: 'o1', title: 'Bad', createdBy: 'u1',
      fields: [{ key: 'summary', label: 'S', type: 'text', required: true }],
      intakeBinding: { listId: 'list:x', titleField: 'nope' },
    })).rejects.toMatchObject({ code: 'validation_error' });
    // A missing listId is rejected.
    await expect(createForm({
      tenantId: 't1', orgId: 'o1', title: 'Bad2', createdBy: 'u1',
      fields: [{ key: 'summary', label: 'S', type: 'text', required: true }],
      intakeBinding: { titleField: 'summary' },
    })).rejects.toMatchObject({ code: 'validation_error' });
    // `null` clears the binding.
    const cleared = await updateForm('t1', 'o1', f.formId, { intakeBinding: null });
    expect(cleared?.intakeBinding).toBeUndefined();
  });

  it('a fields-only patch that orphans a mapped field is rejected, not silently kept (BE#1)', async () => {
    const f = await createForm({
      tenantId: 't1', orgId: 'o1', title: 'Request', createdBy: 'u1',
      fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }, { key: 'detail', label: 'Detail', type: 'textarea', required: false }],
      intakeBinding: { listId: 'list:abc', titleField: 'summary', notesField: 'detail' },
    });
    // Removing the mapped `summary` field via a fields-ONLY patch (no binding
    // re-sent) must 400 at patch time — not silently keep an orphaned binding.
    await expect(updateForm('t1', 'o1', f.formId, {
      fields: [{ key: 'detail', label: 'Detail', type: 'textarea', required: false }],
    })).rejects.toMatchObject({ code: 'validation_error' });
    // A fields-only patch that keeps the mapped fields leaves the binding intact.
    const ok = await updateForm('t1', 'o1', f.formId, {
      fields: [{ key: 'summary', label: 'Summary (renamed label)', type: 'text', required: true }, { key: 'detail', label: 'Detail', type: 'textarea', required: false }],
    });
    expect(ok?.intakeBinding).toMatchObject({ titleField: 'summary', notesField: 'detail' });
  });

  it('get-submission node projects the binding into idea-shaped fields (willFile guard)', async () => {
    const mod = await import('../../../packs/feature.forms.nodes/index.mjs');
    const surf = buildFormsSurface({ tenantId: 't1' });
    const ctx = (inputs: Record<string, unknown>) => ({ features: { forms: surf }, inputs });

    // A BOUND form → willFile:'yes', idea-shaped fields mapped from the values.
    const bound = await createForm({
      tenantId: 't1', orgId: 'o1', title: 'Feature request', createdBy: 'u1',
      fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }, { key: 'detail', label: 'Detail', type: 'textarea', required: false }],
      intakeBinding: { listId: 'list:features', titleField: 'summary', notesField: 'detail' },
    });
    const sub = await recordSubmission(bound, { summary: 'Dark mode', detail: 'at night' }, {});
    const r1 = await mod.nodes['feature.forms.nodes.get-submission'](ctx({ orgId: 'o1', formId: bound.formId, submissionId: sub.submissionId }));
    expect(r1.status).toBe('success');
    expect(r1.outputs).toMatchObject({ willFile: 'yes', listId: 'list:features', title: 'Dark mode', description: 'at night', orgId: 'o1' });

    // An UNBOUND form → willFile:'no', empty idea fields (the chain no-ops).
    const unbound = await createForm({ tenantId: 't1', orgId: 'o1', title: 'Contact', createdBy: 'u1', fields: [{ key: 'msg', label: 'Message', type: 'textarea', required: true }] });
    const sub2 = await recordSubmission(unbound, { msg: 'hi' }, {});
    const r2 = await mod.nodes['feature.forms.nodes.get-submission'](ctx({ orgId: 'o1', formId: unbound.formId, submissionId: sub2.submissionId }));
    expect(r2.outputs).toMatchObject({ willFile: 'no', listId: '', title: '' });

    // A cross-tenant read sees nothing.
    const r3 = await mod.nodes['feature.forms.nodes.get-submission']({ features: { forms: buildFormsSurface({ tenantId: 't2' }) }, inputs: { orgId: 'o1', formId: bound.formId, submissionId: sub.submissionId } });
    expect(r3.outputs).toMatchObject({ found: false, willFile: 'no' });
  });

  it('get-submission falls back to the form title + skips boolean values (BE#2/BE#3)', async () => {
    const mod = await import('../../../packs/feature.forms.nodes/index.mjs');
    const ctx = (inputs: Record<string, unknown>) => ({ features: { forms: buildFormsSurface({ tenantId: 't1' }) }, inputs });

    // titleField bound to an OPTIONAL field left blank → title falls back to the
    // form title (submit-idea requires a non-empty title; must not hard-fail).
    const f1 = await createForm({
      tenantId: 't1', orgId: 'o1', title: 'Beta feedback', createdBy: 'u1',
      fields: [{ key: 'headline', label: 'Headline', type: 'text', required: false }],
      intakeBinding: { listId: 'list:x', titleField: 'headline' },
    });
    const s1 = await recordSubmission(f1, {}, {}); // headline omitted
    const o1 = (await mod.nodes['feature.forms.nodes.get-submission'](ctx({ orgId: 'o1', formId: f1.formId, submissionId: s1.submissionId }))).outputs as { title: string; willFile: string };
    expect(o1).toMatchObject({ willFile: 'yes', title: 'Beta feedback' });

    // titleField bound to a CHECKBOX → the boolean is skipped, not "true".
    const f2 = await createForm({
      tenantId: 't1', orgId: 'o1', title: 'Signup', createdBy: 'u1',
      fields: [{ key: 'agree', label: 'Agree', type: 'checkbox', required: true }],
      intakeBinding: { listId: 'list:y', titleField: 'agree' },
    });
    const s2 = await recordSubmission(f2, { agree: true }, {});
    const o2 = (await mod.nodes['feature.forms.nodes.get-submission'](ctx({ orgId: 'o1', formId: f2.formId, submissionId: s2.submissionId }))).outputs as { title: string };
    expect(o2.title).toBe('Signup'); // NOT 'true'
  });
});
