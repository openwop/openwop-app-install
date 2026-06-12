/**
 * Forms feature routes (host-extension, ADR 0017).
 *   Authed (org-scoped, RBAC):  /v1/host/sample/forms/orgs/:orgId/forms[...]
 *   Public (unauthed):          /v1/host/sample/public-forms/:formId[/submit]
 * The public prefix is on PUBLIC_PATH_PREFIXES (auth.ts) — `public-forms` does
 * NOT shadow the authed `…/forms/*`. The public submit relies on the global
 * per-IP rate-limit middleware for abuse control (plus the honeypot + caps here).
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString } from '../featureRoute.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import {
  listForms, getForm, createForm, updateForm, setFormStatus, deleteForm,
  listSubmissions, getPublishedForm, validateValues, recordSubmission,
  HONEYPOT_FIELD, type FormStatus, type Submission,
} from './formsService.js';

const FEATURE = { toggleId: 'forms', label: 'Forms' };
const ORG = '/v1/host/sample/forms/orgs/:orgId';
const PUB = '/v1/host/sample/public-forms';

type Scope = 'workspace:read' | 'workspace:write';

export function registerFormsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  // ───────────────────────── authed org-scoped management ─────────────────────
  app.post(`${ORG}/forms`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const submitMessage = optionalString(body.submitMessage);
      const form = await createForm({
        tenantId: user.tenantId,
        orgId,
        title: requireString(body.title, 'title'),
        fields: body.fields ?? [],
        createToContact: body.createToContact === true,
        ...(submitMessage ? { submitMessage } : {}),
        createdBy: user.userId,
      });
      res.status(201).json(form);
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/forms`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      res.json({ forms: await listForms(user.tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/forms/:formId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const form = await getForm(user.tenantId, orgId, req.params.formId);
      if (!form) throw new OpenwopError('not_found', 'Form not found.', 404, { formId: req.params.formId });
      res.json(form);
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/forms/:formId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: { title?: string; fields?: unknown; createToContact?: boolean; submitMessage?: string } = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (body.fields !== undefined) patch.fields = body.fields;
      if (typeof body.createToContact === 'boolean') patch.createToContact = body.createToContact;
      if (typeof body.submitMessage === 'string') patch.submitMessage = body.submitMessage;
      const form = await updateForm(user.tenantId, orgId, req.params.formId, patch);
      if (!form) throw new OpenwopError('not_found', 'Form not found.', 404, { formId: req.params.formId });
      res.json(form);
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/forms/:formId/status`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const status = (req.body ?? {} as Record<string, unknown>).status;
      if (status !== 'draft' && status !== 'published') throw new OpenwopError('validation_error', '`status` MUST be `draft` or `published`.', 400, { field: 'status' });
      const form = await setFormStatus(user.tenantId, orgId, req.params.formId, status as FormStatus);
      if (!form) throw new OpenwopError('not_found', 'Form not found.', 404, { formId: req.params.formId });
      res.json(form);
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/forms/:formId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const ok = await deleteForm(user.tenantId, orgId, req.params.formId);
      if (!ok) throw new OpenwopError('not_found', 'Form not found.', 404, { formId: req.params.formId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/forms/:formId/submissions`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const form = await getForm(user.tenantId, orgId, req.params.formId);
      if (!form) throw new OpenwopError('not_found', 'Form not found.', 404, { formId: req.params.formId });
      res.json({ submissions: await listSubmissions(user.tenantId, orgId, req.params.formId) });
    } catch (err) { next(err); }
  });

  // ───────────────────────── public unauthed render + submit ──────────────────
  // A published form, gated on ITS tenant's `forms` toggle. Tenant from the form,
  // never the request. Uniform 404 on missing / unpublished / feature-off.
  const resolvePublic = async (formId: string): Promise<NonNullable<Awaited<ReturnType<typeof getPublishedForm>>>> => {
    const notFound = (): never => { throw new OpenwopError('not_found', 'Form not found.', 404, {}); };
    if (typeof formId !== 'string' || formId.length > 128) notFound();
    const form = await getPublishedForm(formId);
    if (!form) return notFound();
    const assignment = await resolveOne(FEATURE.toggleId, { tenantId: form.tenantId });
    if (!assignment || !assignment.enabled) return notFound();
    return form;
  };

  app.get(`${PUB}/:formId`, async (req, res, next) => {
    try {
      const form = await resolvePublic(req.params.formId);
      res.json({
        formId: form.formId,
        title: form.title,
        fields: form.fields,
        honeypotField: HONEYPOT_FIELD,
        ...(form.submitMessage ? { submitMessage: form.submitMessage } : {}),
      });
    } catch (err) { next(err); }
  });

  app.post(`${PUB}/:formId/submit`, async (req, res, next) => {
    try {
      const form = await resolvePublic(req.params.formId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const values = (body.values ?? {}) as Record<string, unknown>;
      // honeypot: a filled decoy ⇒ a bot ⇒ silent success, no row persisted.
      const hp = values[HONEYPOT_FIELD];
      if (typeof hp === 'string' && hp.trim() !== '') { res.status(200).json({ ok: true }); return; }
      const clean = validateValues(form, values);
      const meta: Submission['meta'] = {};
      const referrer = optionalString(body.referrer);
      if (referrer) meta.referrer = referrer;
      if (body.utm && typeof body.utm === 'object') {
        const utm: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.utm as Record<string, unknown>)) if (typeof v === 'string') utm[k] = v;
        if (Object.keys(utm).length > 0) meta.utm = utm;
      }
      const submission = await recordSubmission(form, clean, meta);
      res.status(201).json({ ok: true, submissionId: submission.submissionId, ...(form.submitMessage ? { message: form.submitMessage } : {}) });
    } catch (err) { next(err); }
  });
}
