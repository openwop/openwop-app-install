/**
 * Forms feature routes (host-extension, ADR 0017).
 *   Authed (org-scoped, RBAC):  /v1/host/openwop-app/forms/orgs/:orgId/forms[...]
 *   Public (unauthed):          /v1/host/openwop-app/public-forms/:formId[/submit]
 * The public prefix is on PUBLIC_PATH_PREFIXES (auth.ts) — `public-forms` does
 * NOT shadow the authed `…/forms/*`. The public submit relies on the global
 * per-IP rate-limit middleware for abuse control (plus the honeypot + caps here).
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString } from '../featureRoute.js';
import { listFormTemplateEntries, getFormTemplateEntry } from '../../host/formContentPackLoader.js';
import { createLogger } from '../../observability/logger.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { runSubmitGuards } from './submitGuards.js';
// Cross-feature (ADR 0226): the identity link is written through its owning
// analytics service, gated by the ONE consent helper (the beacon's own gate).
import { linkSession } from '../analytics/identityLinkService.js';
import { isAllowed } from '../consent/consentService.js';
import {
  listForms, getForm, createForm, updateForm, setFormStatus, deleteForm,
  listSubmissions, listSubmissionsPage, getPublishedForm, validateValues, recordSubmission,
  deleteSubmission, submissionStatsOf, HONEYPOT_FIELD, type FormStatus, type Submission,
} from './formsService.js';

const FEATURE = { toggleId: 'forms', label: 'Forms' };
const ORG = '/v1/host/openwop-app/forms/orgs/:orgId';

const capLog = createLogger('forms.capture');
const PUB = '/v1/host/openwop-app/public-forms';

/** FORM-2 — the per-string cap on public `meta`, matched to the analytics
 *  beacon's `MAX_STR` (`analytics/analyticsService.ts`) so the two public write
 *  paths bound the same fields the same way. */
const MAX_META_STR = 1_024;
/** FORM-2 — the CLOSED attribution allowlist. Anything else on `body.utm` is
 *  dropped: the operator's inbox and CSV export render these cells verbatim, so
 *  an open-ended copy loop let a crafted share link write arbitrary text into
 *  them. Matches the five standard UTM parameters plus `utm_id` (GA4). */
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id'] as const;

type Scope = 'workspace:read' | 'workspace:write';

export function registerFormsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  // ───────────────────────── form templates (ADR 0516) ───────────────────────
  // The catalog is READ-ONLY pack data — no tenant rows — but it stays behind the
  // same org gate as the rest of the feature: which templates exist is not a
  // secret, yet an ungated sibling route beside gated ones is how a surface
  // quietly becomes reachable without membership.
  app.get(`${ORG}/form-templates`, async (req, res, next) => {
    try {
      await authz(req, 'workspace:read');
      // DOCTPL-19 — each catalog entry carries its pack provenance so the
      // gallery can attribute the source (packName@packVersion). Additive.
      res.json({ templates: listFormTemplateEntries() });
    } catch (err) { next(err); }
  });

  // Instantiate a template into a real form. Deliberately a THIN wrapper over the
  // ordinary create path (ADR 0516 §Security): the template supplies a title and
  // fields, and `createForm` sanitizes them exactly as it sanitizes typed input.
  // Writing a FormDef row directly here would bypass `sanitizeFields` and let pack
  // data define a public submission surface unchecked.
  app.post(`${ORG}/forms/from-template`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const templateId = requireString(body.templateId, 'templateId');
      const entry = getFormTemplateEntry(templateId);
      // A missing template is a 404 naming the id — an operator who mistypes, or
      // whose pack was tombstoned, must be able to tell that from a server error.
      if (!entry) throw new OpenwopError('not_found', `Form template '${templateId}' is not installed.`, 404, { templateId });
      const tpl = entry.template;
      const form = await createForm({
        tenantId,
        orgId,
        // The caller may override the title; the template's is the default.
        title: optionalString(body.title) ?? tpl.title,
        fields: tpl.fields,
        createToContact: false,
        // Provenance comes from the REGISTRY, never from `body` — this route
        // reads no origin off the wire, so the stamp cannot be forged.
        originTemplate: { templateId, packName: entry.packName, packVersion: entry.packVersion, templateVersion: entry.templateVersion },
        createdBy: user.userId,
      });
      res.status(201).json(form);
    } catch (err) { next(err); }
  });

  // ───────────────────────── authed org-scoped management ─────────────────────
  app.post(`${ORG}/forms`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const submitMessage = optionalString(body.submitMessage);
      const form = await createForm({
        tenantId,
        orgId,
        title: requireString(body.title, 'title'),
        fields: body.fields ?? [],
        createToContact: body.createToContact === true,
        ...(body.emailOptInField !== undefined ? { emailOptInField: body.emailOptInField } : {}),
        ...(submitMessage ? { submitMessage } : {}),
        ...(body.intakeBinding !== undefined ? { intakeBinding: body.intakeBinding } : {}),
        createdBy: user.userId,
      });
      res.status(201).json(form);
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/forms`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      res.json({ forms: await listForms(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/forms/:formId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const form = await getForm(tenantId, orgId, req.params.formId);
      if (!form) throw new OpenwopError('not_found', 'Form not found.', 404, { formId: req.params.formId });
      res.json(form);
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/forms/:formId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: { title?: string; fields?: unknown; createToContact?: boolean; emailOptInField?: unknown; submitMessage?: string; intakeBinding?: unknown } = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (body.fields !== undefined) patch.fields = body.fields;
      if (typeof body.createToContact === 'boolean') patch.createToContact = body.createToContact;
      if (typeof body.submitMessage === 'string') patch.submitMessage = body.submitMessage;
      if (body.intakeBinding !== undefined) patch.intakeBinding = body.intakeBinding; // object sets, null clears (ADR 0246)
      if (body.emailOptInField !== undefined) patch.emailOptInField = body.emailOptInField; // string sets, null/'' clears (ADR 0338)
      const form = await updateForm(tenantId, orgId, req.params.formId, patch);
      if (!form) throw new OpenwopError('not_found', 'Form not found.', 404, { formId: req.params.formId });
      res.json(form);
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/forms/:formId/status`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const status = (req.body ?? {} as Record<string, unknown>).status;
      if (status !== 'draft' && status !== 'published') throw new OpenwopError('validation_error', '`status` MUST be `draft` or `published`.', 400, { field: 'status' });
      const form = await setFormStatus(tenantId, orgId, req.params.formId, status as FormStatus);
      if (!form) throw new OpenwopError('not_found', 'Form not found.', 404, { formId: req.params.formId });
      res.json(form);
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/forms/:formId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const ok = await deleteForm(tenantId, orgId, req.params.formId);
      if (!ok) throw new OpenwopError('not_found', 'Form not found.', 404, { formId: req.params.formId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/forms/:formId/submissions`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const form = await getForm(tenantId, orgId, req.params.formId);
      if (!form) throw new OpenwopError('not_found', 'Form not found.', 404, { formId: req.params.formId });
      // FORMS-3 — optional pagination (`?limit=&before=<createdAt~id>`); the
      // no-limit read stays the back-compat full list.
      if (req.query.limit !== undefined) {
        const limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new OpenwopError('validation_error', 'limit MUST be an integer between 1 and 200.', 400);
        }
        const before = typeof req.query.before === 'string' && req.query.before.includes('~') ? req.query.before : undefined;
        res.json(await listSubmissionsPage(tenantId, orgId, req.params.formId, { limit, ...(before ? { before } : {}) }));
        return;
      }
      // ADR 0584 — the abuse numbers ride BOTH shapes, so the two reads cannot
      // disagree about how many leads an abuse control took.
      const stats = await submissionStatsOf(req.params.formId);
      res.json({
        submissions: await listSubmissions(tenantId, orgId, req.params.formId),
        flaggedCount: stats.flaggedCount,
        droppedCount: stats.droppedCount,
      });
    } catch (err) { next(err); }
  });

  // ADR 0584 §Correction (FORM-BUDGET-1) — delete ONE submission. The
  // quarantine budget is occupancy, so this is the operator's only way to give
  // it back short of deleting the whole form (which destroys every real lead
  // with it). `workspace:write`, like every other destructive forms route.
  app.delete(`${ORG}/forms/:formId/submissions/:submissionId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const ok = await deleteSubmission(tenantId, orgId, req.params.formId, req.params.submissionId);
      // A miss is a uniform 404 whether the form, the org or the row is wrong —
      // the same non-probe posture the read above takes.
      if (!ok) throw new OpenwopError('not_found', 'Submission not found.', 404, { submissionId: req.params.submissionId });
      res.status(204).end();
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
      // honeypot: a filled decoy ⇒ probably a bot.
      // FRMB-HP — ANY non-empty value trips the trap (bots post numbers/arrays
      // too); a plain-string check let typed payloads through as "real" leads.
      //
      // ADR 0584 (FORM-UX-1) — WHAT THIS NO LONGER DOES, and why. It used to
      // answer `200 {ok:true}` here and return, persisting NOTHING. Toward a bot
      // that reads as the right posture; toward the browser extension, password
      // manager or AT tooling that filled the hidden `_hp_ref`, it was a lead
      // destroyed while the person was shown "Thanks — your submission was
      // received" and a funnel step advanced. The "never a spam oracle" argument
      // for it does not survive reading the two responses side by side: a clean
      // submit answered `201` WITH a `submissionId` and this answered `200`
      // WITHOUT one, so the trip was already trivially detectable. Quarantining
      // is therefore strictly better on BOTH counts — the responses are now
      // byte-identical (a real oracle-free posture) and the lead survives.
      const hp = values[HONEYPOT_FIELD];
      const hpFilled = hp !== undefined && hp !== null && hp !== false && !(typeof hp === 'string' && hp.trim() === '');
      const meta: Submission['meta'] = {};
      // FORM-2 — `referrer` and `utm` are attacker-controlled strings on an
      // UNAUTHENTICATED write path, and were unbounded in key count, key length
      // and value length while the `context` field two lines below was capped
      // "because public input is never trusted to grow storage". They now take
      // the analytics posture this type's own docblock always claimed:
      // `analyticsService.ts` runs UTM through a CLOSED allowlist + a 1024-char
      // per-value cap, and caps the referrer the same way.
      const referrer = optionalString(body.referrer)?.slice(0, MAX_META_STR);
      if (referrer) meta.referrer = referrer;
      // ADR 0226 (additive): the visitor's analytics session key, bounded to the
      // same 1024-char cap the analytics beacon applies to `sessionKey`.
      const sessionKey = optionalString(body.sessionKey)?.slice(0, MAX_META_STR);
      if (sessionKey) meta.sessionKey = sessionKey;
      if (body.utm && typeof body.utm === 'object') {
        const raw = body.utm as Record<string, unknown>;
        const utm: Record<string, string> = {};
        // The allowlist is the `utm_*` spelling the first-party renderer sends
        // (it copies `utm_`-prefixed query params verbatim), NOT analytics'
        // bare `source`/`medium` — the stored rows and the CSV export columns
        // are in this spelling and must keep reading back.
        for (const k of UTM_KEYS) {
          const v = raw[k];
          if (typeof v === 'string' && v) utm[k] = v.slice(0, MAX_META_STR);
        }
        if (Object.keys(utm).length > 0) meta.utm = utm;
      }
      // ADR 0332 (additive): bounded, opaque embed context — ≤8 string entries,
      // keys ≤64 / values ≤256 chars; anything else is silently dropped (public
      // input is never trusted to grow storage).
      if (body.context && typeof body.context === 'object') {
        const context: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.context as Record<string, unknown>)) {
          if (typeof v !== 'string' || k.length > 64 || v.length > 256) continue;
          if (Object.keys(context).length >= 8) break;
          context[k] = v;
        }
        if (Object.keys(context).length > 0) meta.context = context;
      }
      // ADR 0338 §D4 — registered submit guards; a deny takes the same
      // QUARANTINE posture as the honeypot. This seam is built for CAPTCHA
      // providers, which have real false-positive rates, so "deny ⇒ discard the
      // lead and say thank-you" was the worst possible default here.
      const guardAllowed = hpFilled || (await runSubmitGuards(form, values, meta));
      const flagged: Submission['flagged'] | undefined = hpFilled ? 'honeypot' : guardAllowed ? undefined : 'guard';
      if (flagged) capLog.warn(flagged === 'honeypot' ? 'honeypot_dropped' : 'guard_denied', { formId: form.formId, tenantId: form.tenantId });
      const clean = validateValues(form, values);
      // FRMB-IDEM — optional at-most-once key (bounded, opaque); absent keeps
      // the legacy always-append shape.
      const clientKey = typeof body.clientKey === 'string' && body.clientKey.length > 0 && body.clientKey.length <= 128 ? body.clientKey : undefined;
      const submission = await recordSubmission(form, clean, meta, clientKey, flagged);
      // D4 (ADR 0226): deterministic session↔contact link — only when a session
      // key was supplied AND a contact was actually created/matched AND the
      // analytics consent gate passes (mirrors the beacon's own gate). BEST-
      // EFFORT: a link failure never fails the submit (the lead is captured).
      if (sessionKey && submission.contactId) {
        try {
          if (await isAllowed(form.tenantId, sessionKey, 'analytics')) {
            await linkSession(form.tenantId, sessionKey, submission.contactId, 'form-submit');
          }
        } catch { /* best-effort — submission already durable */ }
      }
      res.status(201).json({ ok: true, submissionId: submission.submissionId, ...(form.submitMessage ? { message: form.submitMessage } : {}) });
    } catch (err) { next(err); }
  });
}
