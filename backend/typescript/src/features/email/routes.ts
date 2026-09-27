/**
 * Email Marketing routes (host-extension, ADR 0019). Authed + org-scoped + RBAC for
 * templates + campaigns CRUD and a send that resolves the audience live from
 * contactsService and consent-gates on `marketing` — PLUS six UNAUTHENTICATED public
 * endpoints (unsubscribe, preference center, open pixel, click redirect, bounce
 * webhooks), token- or signature-gated, uniform 404 on refusal. (Corrected
 * 2026-09-11 — EM-26: this header said "NO public surface" while registering them.)
 */

import express, { type Request, type Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString } from '../featureRoute.js';
import { checkEntitlement } from '../../host/entitlementSeam.js';
import { CONTACT_STAGES, type ContactStage } from '../crm/contactsService.js';
import { getConsent, mergeConsentCategories, fullMarketingOptOut, isErasureTombstoned } from '../consent/consentService.js';

/** The channels the EMAIL preference-center page manages. Deliberately NOT the
 *  full `MARKETING_CHANNELS`: `marketing.whatsapp` (ADR 0394) is strict
 *  explicit-opt-in captured at collection time on the WhatsApp surface — an
 *  umbrella-prefilled checkbox here would misstate the gate. */
const PREFERENCE_CHANNELS = ['email', 'sms', 'push'] as const;
type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];
import { addSuppression, suppressionBlocksSend } from '../crm/suppressionService.js';
import {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, type EmailBodyFormat,
  listCampaigns, getCampaign, createCampaign, deleteCampaign, listSends, sendCampaign, sendTestEmail,
  getEmailSettings, setSenderAddress,
} from './emailService.js';
import { recordClick, recordOpen, recordUnsubscribe, resolveUnsubscribeToken, siblingPreferencesToken, resolvePreferencesToken, engagementStats, listEngagement } from './engagementService.js';
import { renderMarkdownPreview } from './safeMarkdown.js';

/** ADR 0256 — narrow an untrusted body field to a known body format (else undefined). */
const parseFormat = (v: unknown): EmailBodyFormat | undefined => (v === 'markdown' ? 'markdown' : v === 'text' ? 'text' : undefined);
import { publicPageBundle, resolvePublicLocale, type PublicPageT, type PublicPageKey } from './publicPageStrings.js';
import { setWebhookConfig, listWebhookConfigs, removeWebhookConfig, ingestBounceWebhook, isBounceProvider } from './bounceWebhooks.js';
import { emailSendProviders } from '../../host/emailAdapter.js';
import { resolveConnectionCredential } from '../connections/connectionsService.js';
import { makeBrokeredCampaignProvider } from './brokeredProvider.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('email.routes');
const FEATURE = { toggleId: 'email', label: 'Email Marketing' };
const ORG = '/v1/host/openwop-app/email/orgs/:orgId';
type Scope = 'workspace:read' | 'workspace:write';

export function registerEmailRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;
  // ADR 0419 — gate on the tenant's plan/bundle entitlement at the ONE authz choke
  // (the commerce precedent). No-op unless an operator narrows OPENWOP_BILLING_PLAN_FEATURES
  // with billing on; an active `crm`-bundle grant re-includes `email`.
  // NOTE: the ADR 0419 CENTRAL gate (`requireFeatureEnabled`, called by authorizeOrgScope)
  // now ALSO enforces this — kept as deliberate defense-in-depth on a revenue path.
  const authz = async (req: Request, scope: Scope) => {
    const ctx = await authorizeOrgScope(req, FEATURE, scope);
    await checkEntitlement(req, FEATURE.toggleId);
    return ctx;
  };

  // ── settings (sender identity — required before campaigns can send) ──
  app.get(`${ORG}/settings`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const s = await getEmailSettings(tenantId, orgId);
      res.json({ senderAddress: s?.senderAddress ?? '', configured: !!s?.senderAddress });
    } catch (err) { next(err); }
  });
  app.put(`${ORG}/settings`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const senderAddress = typeof body.senderAddress === 'string' ? body.senderAddress : '';
      const s = await setSenderAddress(tenantId, orgId, senderAddress, user.userId);
      res.json({ senderAddress: s.senderAddress, configured: !!s.senderAddress });
    } catch (err) { next(err); }
  });

  // ── bounce/complaint webhook config (ADR 0241) — operator configures a
  //    provider event webhook; a verified delivery suppresses hard bounces +
  //    complaints. The verification secret is KMS-enveloped and never returned. ──
  app.get(`${ORG}/webhook-configs`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const configs = await listWebhookConfigs(tenantId, orgId);
      // Never leak the secret; return the ingest URL the operator points the provider at.
      res.json({ configs: configs.map((c) => ({ webhookId: c.webhookId, provider: c.provider, enabled: c.enabled, ingestPath: `/v1/host/openwop-app/public-email/events/${c.webhookId}`, updatedAt: c.updatedAt })) });
    } catch (err) { next(err); }
  });
  app.post(`${ORG}/webhook-configs`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const provider = typeof body.provider === 'string' ? body.provider : '';
      if (!isBounceProvider(provider)) throw new OpenwopError('validation_error', 'provider must be sendgrid or postmark.', 400, { field: 'provider' });
      const verificationSecret = requireString(body.verificationSecret, 'verificationSecret');
      const cfg = await setWebhookConfig({
        tenantId, orgId, provider, verificationSecret,
        ...(typeof body.webhookId === 'string' && body.webhookId ? { webhookId: body.webhookId } : {}),
      });
      res.status(201).json({ webhookId: cfg.webhookId, provider: cfg.provider, ingestPath: `/v1/host/openwop-app/public-email/events/${cfg.webhookId}` });
    } catch (err) { next(err); }
  });
  app.delete(`${ORG}/webhook-configs/:webhookId`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:write');
      const removed = await removeWebhookConfig(tenantId, req.params.webhookId);
      res.json({ removed });
    } catch (err) { next(err); }
  });

  // ── provider status (Deferred Phase B.1 / ADM-12; extends ADR 0193) ──
  // Read-only operator visibility: which transactional providers the CALLER
  // can broker (their connections), the host default, and the org's sender
  // identity. No secrets — booleans + identifiers only.
  app.get(`${ORG}/provider-status`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:read');
      const candidates = emailSendProviders();
      // Deliberate: "connected" = the broker can ACTUALLY resolve a usable
      // credential for this caller (a KMS miss honestly reads as not
      // connected), at the cost of touching the secret path for a boolean.
      // A select-only existence check would be cheaper but can lie.
      const providers = await Promise.all(candidates.map(async (provider) => ({
        provider,
        connected: !!(await resolveConnectionCredential({
          tenantId, provider, actingUserId: user.userId, orgId,
        }).catch(() => null)),
      })));
      const settings = await getEmailSettings(tenantId, orgId);
      res.json({
        providers,
        defaultProvider: process.env.OPENWOP_EMAIL_DEFAULT_PROVIDER ?? null,
        senderAddress: settings?.senderAddress ?? null,
      });
    } catch (err) { next(err); }
  });

  // ── templates ──
  app.post(`${ORG}/templates`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const t = await createTemplate({ tenantId, orgId, name: requireString(body.name, 'name'), subject: requireString(body.subject, 'subject'), body: requireString(body.body, 'body'), ...(parseFormat(body.format) ? { format: parseFormat(body.format) } : {}), createdBy: user.userId });
      res.status(201).json(t);
    } catch (err) { next(err); }
  });
  // ADR 0256 — server-authoritative safe-markdown preview for the compose editor
  //   (single renderer → what you see is what sends, modulo tracked links + pixel).
  app.post(`${ORG}/preview`, async (req, res, next) => {
    try {
      await authz(req, 'workspace:read');
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json({ html: renderMarkdownPreview(requireString(body.body, 'body')) });
    } catch (err) { next(err); }
  });
  app.get(`${ORG}/templates`, async (req, res, next) => {
    try { const { orgId, tenantId } = await authz(req, 'workspace:read'); res.json({ templates: await listTemplates(tenantId, orgId) }); }
    catch (err) { next(err); }
  });
  // ADR 0519 — ONE template by id, for the `/email/templates/:templateId` editor.
  // That page is reachable by bookmark, shared link, or reload with no list in
  // memory, so it must not depend on the collection page having fetched one.
  // Host-extension route (`/v1/host/openwop-app/*`) — non-normative, no RFC.
  app.get(`${ORG}/templates/:templateId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const tpl = await getTemplate(tenantId, orgId, req.params.templateId);
      if (!tpl) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: req.params.templateId });
      res.json(tpl);
    } catch (err) { next(err); }
  });
  app.patch(`${ORG}/templates/:templateId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: { name?: string; subject?: string; body?: string; format?: EmailBodyFormat } = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if (typeof body.subject === 'string') patch.subject = body.subject;
      if (typeof body.body === 'string') patch.body = body.body;
      const fmt = parseFormat(body.format);
      if (fmt) patch.format = fmt;
      const t = await updateTemplate(tenantId, orgId, req.params.templateId, patch);
      if (!t) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: req.params.templateId });
      res.json(t);
    } catch (err) { next(err); }
  });
  app.delete(`${ORG}/templates/:templateId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      if (!(await deleteTemplate(tenantId, orgId, req.params.templateId))) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: req.params.templateId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── campaigns ──
  app.post(`${ORG}/campaigns`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const templateId = requireString(body.templateId, 'templateId');
      if (!(await getTemplate(tenantId, orgId, templateId))) throw new OpenwopError('validation_error', 'Unknown templateId for this org.', 400, { templateId });
      const stage = optionalString(body.stage);
      if (stage && !CONTACT_STAGES.includes(stage as ContactStage)) throw new OpenwopError('validation_error', '`stage` is not a valid contact stage.', 400, { field: 'stage' });
      const segmentId = optionalString(body.segmentId);
      // Mutual-exclusivity + segment-existence are enforced in `createCampaign`
      // itself (ADR 0211 §2) so every caller — this route, a replay/fork, a
      // future workflow verb — gets the same 400, not just the HTTP path.
      const c = await createCampaign({
        tenantId, orgId, templateId,
        ...(stage ? { stage: stage as ContactStage } : {}),
        ...(segmentId ? { segmentId } : {}),
        createdBy: user.userId,
      });
      res.status(201).json(c);
    } catch (err) { next(err); }
  });
  app.get(`${ORG}/campaigns`, async (req, res, next) => {
    try { const { orgId, tenantId } = await authz(req, 'workspace:read'); res.json({ campaigns: await listCampaigns(tenantId, orgId) }); }
    catch (err) { next(err); }
  });
  app.delete(`${ORG}/campaigns/:campaignId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      if (!(await deleteCampaign(tenantId, orgId, req.params.campaignId))) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
      res.status(204).end();
    } catch (err) { next(err); }
  });
  app.post(`${ORG}/campaigns/:campaignId/send`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const resend = (req.body ?? {} as Record<string, unknown>).resend === true;
      // Order of honest failures: sender address unconfigured → 501
      // capability_not_provided (checked in sendCampaign, before the provider is
      // needed); no SendGrid connection for the acting user → 409
      // credential_required (preflighted here, ONCE, not per-recipient). Real
      // dispatch rides the EXISTING ctx.email.send brokered SendGrid spine
      // (ADR 0024 / ADR 0019 correction note) — no parallel egress path.
      const settingsRow = await getEmailSettings(tenantId, orgId);
      const provider = settingsRow?.senderAddress
        ? await makeBrokeredCampaignProvider({ storage, tenantId, orgId, actingUserId: user.userId, purpose: 'marketing' })
        : undefined; // sendCampaign 501s on the missing sender before any dispatch
      const c = await sendCampaign(tenantId, orgId, req.params.campaignId, { resend, ...(provider ? { provider } : {}) });
      if (!c) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
      res.json(c);
    } catch (err) { next(err); }
  });
  // R2 EM-G3 — test send: one email to an explicit recipient; marked, never
  // ledgered (stats derive from the ledger, so a test row would corrupt them).
  app.post(`${ORG}/campaigns/:campaignId/test-send`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const to = typeof (req.body ?? {}).to === 'string' ? (req.body as { to: string }).to.trim() : '';
      const settingsRow = await getEmailSettings(tenantId, orgId);
      const provider = settingsRow?.senderAddress
        ? await makeBrokeredCampaignProvider({ storage, tenantId, orgId, actingUserId: user.userId, purpose: 'marketing' })
        : undefined;
      await sendTestEmail(tenantId, orgId, req.params.campaignId, to, provider ? { provider } : {});
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // C4 (ADR 0218) — engagement read: clicks + unsubscribes for one campaign.
  app.get(`${ORG}/campaigns/:campaignId/engagement`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      // R2 EM-SP-3 — the sends route verifies the campaign belongs to THIS
      // org; this route didn't, so any org in the tenant could read another
      // org's engagement events by id.
      if (!(await getCampaign(tenantId, orgId, req.params.campaignId))) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
      const stats = await engagementStats(tenantId, req.params.campaignId);
      const events = await listEngagement(tenantId, req.params.campaignId);
      res.json({ stats, events: events.slice(0, 200) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/campaigns/:campaignId/sends`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      if (!(await getCampaign(tenantId, orgId, req.params.campaignId))) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
      res.json({ sends: await listSends(tenantId, req.params.campaignId) });
    } catch (err) { next(err); }
  });

  // ── C4 (ADR 0218) — PUBLIC engagement endpoints ─────────────────────────
  // Unauthed by design (the recipient's mail client follows them); the prefix
  // is allowlisted in middleware/auth.ts. Tokens are opaque server-side rows —
  // no contact id or address ever rides a URL. Toggle-independent: a recipient
  // must always be able to unsubscribe, even if the email feature is later
  // toggled off (CAN-SPAM/GDPR posture).
  const PUB = '/v1/host/openwop-app/public-email';
  const urlencoded = express.urlencoded({ extended: false, limit: '16kb' });

  // ── ADR 0241 — PUBLIC bounce/complaint receive endpoint ─────────────────────
  // Signature-gated (the provider signature IS the credential; no host auth),
  // toggle-independent (a provider keeps POSTing regardless). Resolves the tenant
  // from the opaque :webhookId's stored config, verifies the provider signature
  // BEFORE any parsing, then suppresses hard bounces + complaints. The raw body
  // for signature verification is captured by the scoped parser in index.ts.
  app.post(`${PUB}/events/:webhookId`, async (req, res, next) => {
    try {
      const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
      const outcome = await ingestBounceWebhook({
        webhookId: req.params.webhookId,
        rawBody,
        body: req.body,
        headers: {
          sendgridSignature: req.get('x-twilio-email-event-webhook-signature') ?? undefined,
          sendgridTimestamp: req.get('x-twilio-email-event-webhook-timestamp') ?? undefined,
          authorization: req.get('authorization') ?? undefined,
        },
        now: Date.now(),
      });
      switch (outcome.status) {
        case 'not_found': res.status(404).type('text/plain').send('Unknown webhook.'); return;
        case 'unauthorized': res.status(401).type('text/plain').send('Signature verification failed.'); return;
        case 'too_large': res.status(413).type('text/plain').send('Event batch too large.'); return;
        default:
          // ADR 0655 D9 (EM-8) — a signal whose suppression write did not land answers 503
          // so the provider REDELIVERS (hard signals are idempotent); 200 said "received"
          // over a bounce that never suppressed.
          res.status(outcome.failed > 0 ? 503 : 200).json({ received: outcome.failed === 0, suppressed: outcome.suppressed, escalated: outcome.escalated, failed: outcome.failed }); return;
      }
    } catch (err) { next(err); }
  });

  // ADR 0242 — open-tracking pixel. ALWAYS serves the 1×1 transparent GIF (never
  // a broken image in the recipient's inbox); records an open only when the token
  // resolves. `no-store` so a caching proxy can't swallow re-opens. Opens are
  // APPROXIMATE (image-load dependent) — see the ADR.
  const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  app.get(`${PUB}/o/:token`, async (req, res, next) => {
    try {
      await recordOpen(req.params.token).catch(() => undefined); // best-effort
      res.status(200).set('Cache-Control', 'no-store, no-cache, must-revalidate, private').set('Pragma', 'no-cache').type('image/gif').send(PIXEL_GIF);
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/c/:token`, async (req, res, next) => {
    try {
      const url = await recordClick(req.params.token);
      if (!url) { res.status(404).send('Unknown link.'); return; }
      // ENG-1: guard the open-redirect at the SINK — only ever 302 to an http(s)
      // destination, independent of the mint path's `https?://` regex. Belt-and-
      // suspenders: any future writer of a click URL stays safe here. A non-
      // http(s) scheme (javascript:, data:) or an unparseable URL 404s, never
      // redirects. (Not a domain allowlist — email legitimately links to many
      // hosts, so allowlisting would break the feature.)
      if (!isSafeRedirect(url)) { res.status(404).send('Unknown link.'); return; }
      res.redirect(302, url);
    } catch (err) { next(err); }
  });
  // GET renders a CONFIRM page — it MUST NOT mutate (grade-code AUDIT-3):
  // mail-security scanners, corporate link-rewriters, and browser prefetchers
  // issue GET on every link in an email, so a state-changing GET auto-
  // unsubscribes recipients who never clicked, silently eroding the list on
  // every send. The POST below performs the opt-out (RFC 8058 one-click posture,
  // mirroring the /p GET-shows / POST-writes split).
  app.get(`${PUB}/u/:token`, async (req, res, next) => {
    try {
      const row = await resolveUnsubscribeToken(req.params.token);
      // CMPUX-16: localize from the recipient's Accept-Language (their browser).
      const locale = resolvePublicLocale(req.headers['accept-language']);
      if (!row) { log.info('public token refused', { kind: 'unsubscribe' }); sendPublicError(res, 404, 'unknownUnsubscribeLink', locale); return; }
      res.status(200).type('html').send(renderUnsubscribePage(req.params.token, 'prompt', publicPageBundle(locale), locale, row.prefsToken));
    } catch (err) { next(err); }
  });
  app.post(`${PUB}/u/:token`, urlencoded, async (req, res, next) => {
    try {
      const locale = resolvePublicLocale(req.headers['accept-language']);
      // ENG-2: defense-in-depth same-origin guard (the token remains the primary
      // guard; RFC 8058 no-Origin one-click POSTs pass).
      if (!sameOriginOrAbsent(req)) { sendPublicError(res, 403, 'crossOriginRejected', locale); return; }
      // EM-UX-2: read the sibling BEFORE the mutation — `recordUnsubscribe`
      // resolves the row internally and does not hand it back.
      const prefsToken = await siblingPreferencesToken(req.params.token);
      const outcome = await recordUnsubscribe(req.params.token);
      if (outcome.status === 'unknown') { log.info('public token refused', { kind: 'unsubscribe' }); sendPublicError(res, 404, 'unknownUnsubscribeLink', locale); return; }
      // EM-2/EM-UX-1: a failed durable write MUST NOT render the done page. On
      // 'partial' the recipient is still on the list, so we render the honest
      // failure state — which keeps the POST form on the page, because the done
      // state renders no form and left the recipient with no retry path at all.
      // The 503 is an HONEST STATUS, and that is the whole of its rationale
      // (review MEDIUM-4). This comment used to justify it as "an RFC 8058
      // one-click POST is a machine caller that reads the status" — that
      // describes a caller THIS PRODUCT DOES NOT HAVE: the host emits no
      // `List-Unsubscribe` / `List-Unsubscribe-Post` header on any send (see the
      // note at the top of engagementService.ts), so no mail provider will ever
      // POST here. The only caller is the human browser submitting the page's own
      // form. The 503 stands because a durable write that did not land must not be
      // reported as 2xx to anyone — a proxy, a log, a curl, a future one-click
      // integration — and the page it renders carries the retry. Every leg is
      // idempotent, so re-submitting completes the opt-out.
      const done = outcome.status === 'revoked';
      res.status(done ? 200 : 503).type('html')
        .send(renderUnsubscribePage(req.params.token, done ? 'done' : 'failed', publicPageBundle(locale), locale, prefsToken ?? undefined));
    } catch (err) { next(err); }
  });

  // ── ADR 0227 — PUBLIC preference center ─────────────────────────────────
  // Same public-token posture as /c and /u (opaque token, no PII in the URL,
  // toggle-independent — a recipient must always be able to narrow consent).
  // Server-rendered, self-contained HTML (inline styles, zero external assets)
  // — deliberately NOT the SPA: it opens from a mail client on any device.
  app.get(`${PUB}/p/:token`, async (req, res, next) => {
    try {
      const locale = resolvePublicLocale(req.headers['accept-language']);
      const row = await resolvePreferencesToken(req.params.token);
      if (!row) { log.info('public token refused', { kind: 'preferences' }); sendPublicError(res, 404, 'unknownPreferencesLink', locale); return; }
      // Prefill: the per-channel specific when the record carries one, else the
      // `marketing` umbrella (exactly the `isAllowed` record-resolution rule).
      const rec = await getConsent(row.tenantId, row.contactId);
      const current = {} as Record<PreferenceChannel, boolean>;
      for (const ch of PREFERENCE_CHANNELS) current[ch] = (rec?.categories[`marketing.${ch}`] ?? rec?.categories.marketing) === true;
      res.status(200).type('html').send(renderPreferencesPage(req.params.token, current, 'form', publicPageBundle(locale), locale));
    } catch (err) { next(err); }
  });
  app.post(`${PUB}/p/:token`, urlencoded, async (req, res, next) => {
    try {
      const locale = resolvePublicLocale(req.headers['accept-language']);
      // ENG-2: defense-in-depth same-origin guard (see /u; the token is primary).
      if (!sameOriginOrAbsent(req)) { sendPublicError(res, 403, 'crossOriginRejected', locale); return; }
      const row = await resolvePreferencesToken(req.params.token);
      if (!row) { log.info('public token refused', { kind: 'preferences' }); sendPublicError(res, 404, 'unknownPreferencesLink', locale); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const on = (k: PreferenceChannel): boolean => { const v = body[k]; return v === 'on' || v === 'true' || v === '1'; };
      const choice = { email: on('email'), sms: on('sms'), push: on('push') };
      const anyOn = choice.email || choice.sms || choice.push;
      // ADR 0655 D3 (EMWF-3 / EM-UX-23) — NARROWING is accepted from this link
      // forever (the opt-out must keep working); WIDENING — any channel turning ON
      // whose EFFECTIVE stored value is off — needs a FRESH link and a clean
      // address. This token binds to nothing (no claim, no TTL — by design for the
      // opt-out), so a forwarded newsletter or a years-old archive used to re-grant
      // marketing consent AND clear the erasure tombstone. "Effective" is the
      // `isAllowed` rule: the channel specific, else the umbrella, else off.
      const stored = await getConsent(row.tenantId, row.contactId);
      const effective = (ch: PreferenceChannel): boolean =>
        (stored?.categories[`marketing.${ch}`] ?? stored?.categories.marketing ?? false) === true;
      const widening = PREFERENCE_CHANNELS.some((ch) => choice[ch] && !effective(ch));
      if (widening) {
        const ageMs = Date.now() - Date.parse(row.createdAt);
        const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= preferenceWidenMs();
        let refused: 'refused-stale' | 'refused-suppressed' | 'refused-erased' | null = fresh ? null : 'refused-stale';
        if (!refused && !row.email) refused = 'refused-suppressed'; // no address on the row ⇒ the suppression leg cannot run
        if (!refused && row.email && (await suppressionBlocksSend(row.tenantId, row.email)) !== 'clear') refused = 'refused-suppressed';
        if (!refused && ((await isErasureTombstoned(row.tenantId, row.contactId)) || (row.email ? await isErasureTombstoned(row.tenantId, row.email) : false))) refused = 'refused-erased'; // ADR 0657 D7 — the truth, and no instruction nobody can honour
        if (refused) {
          log.info('preference-center re-grant refused', { tenantId: row.tenantId, reason: refused, fresh });
          const current = {} as Record<PreferenceChannel, boolean>;
          for (const ch of PREFERENCE_CHANNELS) current[ch] = effective(ch);
          res.status(409).type('html').send(renderPreferencesPage(req.params.token, current, refused, publicPageBundle(locale), locale));
          return;
        }
      }
      // Write through the ONE consent service (never a store write): specifics
      // + the umbrella derived from them (any channel on ⇒ umbrella true; all
      // off ⇒ a full marketing opt-out). This page governs MARKETING only —
      // the subject's analytics choice is preserved, not reset.
      //
      // CONS-3 / review F4 — MERGE, never replace. This was the second writer
      // the CONS-3 census ("all three wholesale writers") missed, and like the
      // one-click unsubscribe it is PUBLIC and unauthenticated. `recordConsent`
      // builds the row from `input` alone, so submitting this form DESTROYED
      // the subject's stored `legalBasis`, `purposes` and `region` — the
      // Art. 6 lawful-basis evidence. The merge carries all three forward and
      // makes the hand-preserved `analytics` unnecessary: an unmentioned
      // category keeps its stored value by construction, which is the whole
      // point of `partialCategories`.
      //
      // WHATSAPP is deliberately asymmetric. This page has no whatsapp control,
      // so on a partial opt-in it is NOT mentioned and keeps its stored value —
      // previously the wholesale write dropped it, meaning ticking "email" here
      // silently revoked a whatsapp opt-in the subject never spoke to (CONS-3's
      // shape, in the restrictive direction). On an ALL-OFF submit the subject
      // IS speaking to the whole umbrella, so `fullMarketingOptOut()` turns
      // every channel off explicitly — under merge semantics a stored
      // `marketing.sms: true` would otherwise outlive a `marketing: false`
      // (`isAllowed` prefers the specific), i.e. an opt-out that does not opt
      // out.
      try {
        await mergeConsentCategories({
          tenantId: row.tenantId,
          subjectKey: row.contactId,
          categories: anyOn
            ? {
              marketing: true,
              'marketing.email': choice.email,
              'marketing.sms': choice.sms,
              'marketing.push': choice.push,
            }
            : fullMarketingOptOut(),
          source: `preference-center:${row.campaignId}`,
          // ADR 0655 D3 — a public, unauthenticated form never un-erases a subject.
          });
      } catch (err) {
        // ADR 0657 D10 — the write barrier: an erased subject's link has nothing to manage;
        // say so (refused-erased) instead of 'saved' over a write that never landed.
        if (err instanceof OpenwopError && err.code === 'subject_erased') {
          const current = {} as Record<PreferenceChannel, boolean>;
          for (const ch of PREFERENCE_CHANNELS) current[ch] = effective(ch);
          res.status(409).type('html').send(renderPreferencesPage(req.params.token, current, 'refused-erased', publicPageBundle(locale), locale));
          return;
        }
        throw err;
      }
      let overlayFailed = false;
      if (!anyOn && row.email) {
        // All channels off = an unsubscribe: mirror `recordUnsubscribe`'s
        // operational overlay (idempotent upsert; removal is an operator act
        // via the authed suppression API — consent alone doesn't un-suppress).
        try { await addSuppression(row.tenantId, row.email, 'unsubscribed', `contact:${row.contactId}`, `preference-center:${row.campaignId}`); }
        catch (e) {
          // EM-2: this used to swallow the failure and render the SAVED page —
          // the same false-success shape as the unsubscribe route one file over.
          // The consent write above did land, but suppression is the overlay
          // `suppressionBlocksSend` reads, so a full opt-out is not enforced.
          overlayFailed = true;
          log.warn('preference-center suppression failed', { error: e instanceof Error ? e.message : String(e) });
        }
      }
      // The form re-renders in every state, so 'partial' already carries its own
      // retry (re-submitting is idempotent). 503 for the same reason as /u — a
      // durable write that did not land is not a 2xx. (NOT a machine-caller
      // argument: nothing but a human browser ever posts here. See /u above.)
      res.status(overlayFailed ? 503 : 200).type('html')
        .send(renderPreferencesPage(req.params.token, choice, overlayFailed ? 'partial' : 'saved', publicPageBundle(locale), locale));
    } catch (err) { next(err); }
  });
}

/** ENG-1: a click destination is safe to 302 to only if it parses as an http(s)
 *  URL. Rejects javascript:/data:/mailto: schemes and malformed URLs at the
 *  redirect sink, independent of the mint path's `https?://` regex. */
function isSafeRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/** The hosts a public-email POST may legitimately originate from: the request's
 *  own Host PLUS any configured public base URL. Behind the Firebase→Cloud Run
 *  proxy the browser Origin is the public host (app.openwop.dev) while Express
 *  may see the internal *.run.app Host — so a bare Origin==Host check would
 *  falsely reject legitimate unsubscribe POSTs (a compliance path). Accepting the
 *  configured bases too keeps the guard robust across that hop. */
function allowedOriginHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  const reqHost = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (reqHost) hosts.add(reqHost);
  for (const env of [process.env.OPENWOP_EMAIL_LINK_BASE_URL, process.env.OPENWOP_PUBLIC_BASE_URL, process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL]) {
    if (typeof env === 'string' && env.trim()) { try { hosts.add(new URL(env.trim()).host); } catch { /* ignore a malformed base */ } }
  }
  return hosts;
}

/** ENG-2: a lenient, null-tolerant same-origin guard for the PUBLIC unauthenticated
 *  POST forms (/u, /p). The opaque per-recipient token is the PRIMARY capability;
 *  this is defense-in-depth against a browser-based cross-site auto-submit by a
 *  token-knowing attacker. Classic CSRF is structurally N/A here — these routes
 *  carry NO ambient credential (no cookie/session; auth is the URL token). Reject
 *  ONLY a PRESENT Origin (fallback Referer) whose host is NOT one of the allowed
 *  hosts; an absent/`null` Origin is ALLOWED so RFC 8058 one-click POSTs
 *  (server-to-server, no Origin) and privacy-stripped mail clients keep working. */
function sameOriginOrAbsent(req: Request): boolean {
  const raw = (typeof req.headers.origin === 'string' && req.headers.origin)
    || (typeof req.headers.referer === 'string' ? req.headers.referer : '');
  if (!raw || raw === 'null') return true; // absent/opaque → allow (the token is the guard)
  let originHost: string;
  try { originHost = new URL(raw).host; } catch { return false; } // present but unparseable → reject
  return originHost !== '' && allowedOriginHosts(req).has(originHost);
}

/** Minimal HTML escaping for the server-rendered preference page — every
 *  interpolated value passes through here (defense in depth; the only dynamic
 *  values are the opaque token and boolean checkbox states). */
function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Shared inline style for the public email pages (grade-ux): a visible
 *  keyboard focus ring on the interactive controls + reduced-motion respect —
 *  these open in mail-client in-app browsers where native rings are often
 *  suppressed. Self-contained (no external assets). */
const PUBLIC_PAGE_STYLE = `<style>
  a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid #1c1c1c; outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>`;

/**
 * EM-UX-2 — the public lane's refusals, as a real page.
 *
 * These were `res.status(404).type('text/plain').send('Unknown preferences
 * link.')`: untranslated, unstyled, no heading, no explanation, no way forward
 * — served to a recipient who had just clicked a link in a marketing email and
 * whose realistic conclusion is that the opt-out is broken. They are the SAME
 * regulated surface as the pages either side of them, so they get the same
 * shell, the same localization, and copy that says what to do next. Still no
 * "back" link, because there is nowhere honest to send them: the host does not
 * know the operator's site from a token that did not resolve.
 */
function sendPublicError(res: Response, status: 403 | 404, key: PublicPageKey, locale: string): void {
  const t = publicPageBundle(locale);
  res.status(status).type('html').send(`<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${PUBLIC_PAGE_STYLE}
<title>${escapeHtml(t('linkProblemTitle'))}</title>
</head>
<body style="margin:0;padding:24px;background:#f4f4f2;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1c1c">
  <main style="max-width:460px;margin:5vh auto;background:#ffffff;border:1px solid #e0e0de;border-radius:12px;padding:28px">
    <h1 style="font-size:1.25rem;margin:0 0 12px">${escapeHtml(t('linkProblemTitle'))}</h1>
    <p role="alert" style="margin:0 0 14px;padding:10px 12px;border-radius:8px;background:#fdecea;border:1px solid #f2b8b5;color:#7a1c17;font-size:0.925rem">${escapeHtml(t(key))}</p>
    <p style="margin:0;color:#555;font-size:0.9rem">${escapeHtml(t('linkProblemNextStep'))}</p>
  </main>
</body>
</html>`);
}

/** The one-click unsubscribe confirm page (grade-code AUDIT-3): GET renders
 *  the `'prompt'` state (no mutation — scanner-safe); the Unsubscribe button
 *  POSTs to perform the opt-out, which renders `'done'` or — EM-2/EM-UX-1 —
 *  `'failed'` when a send-stopping write did not persist. `'failed'` keeps the
 *  POST form so the recipient has a retry: the done state renders no form, so
 *  under the old always-success page the only offered affordance was a link.
 *  Self-contained, same posture as the preference page. */
type UnsubscribePageState = 'prompt' | 'done' | 'failed';
function renderUnsubscribePage(token: string, state: UnsubscribePageState, t: PublicPageT, locale: string, prefsToken?: string): string {
  const action = `/v1/host/openwop-app/public-email/u/${escapeHtml(encodeURIComponent(token))}`;
  // EM-UX-2: the link is built from the SIBLING preferences token, never from
  // the unsubscribe token this page was reached by — `/p/:token` rejects any
  // non-`preferences` kind, so the old self-referential link 404'd for every
  // recipient. When no sibling exists (a row minted before the pair was stored,
  // or a failed preferences mint) the link is OMITTED: an absent escape hatch is
  // honest, a dead one is not.
  const prefs = prefsToken
    ? `/v1/host/openwop-app/public-email/p/${escapeHtml(encodeURIComponent(prefsToken))}`
    : '';
  const submit = (label: PublicPageKey): string =>
    `<form method="post" action="${action}">
      <button type="submit" style="padding:11px 16px;border:0;border-radius:8px;background:#1c1c1c;color:#ffffff;font-size:0.95rem;cursor:pointer">${escapeHtml(t(label))}</button>
    </form>`;
  let body: string;
  if (state === 'done') {
    body = `<p role="status" style="margin:0 0 8px;padding:10px 12px;border-radius:8px;background:#eef6ee;border:1px solid #bcd9bc;color:#1e4620;font-size:0.925rem">${escapeHtml(t('unsubscribedStatus'))}</p>`
      + (prefs ? `
    <p style="margin:0;color:#555;font-size:0.9rem">${escapeHtml(t('changedYourMind'))} <a href="${prefs}">${escapeHtml(t('managePreferences'))}</a>.</p>` : '');
  } else if (state === 'failed') {
    // role="alert" (not "status"): this is inserted on a fresh page load and
    // must be announced — the recipient believes they just left the list.
    body = `<p role="alert" style="margin:0 0 14px;padding:10px 12px;border-radius:8px;background:#fdecea;border:1px solid #f2b8b5;color:#7a1c17;font-size:0.925rem">${escapeHtml(t('unsubscribeFailedStatus'))}</p>
    ${submit('unsubscribeRetryButton')}`;
  } else {
    const lede = prefs
      ? `${escapeHtml(t('unsubscribePrompt'))} <a href="${prefs}">${escapeHtml(t('chooseMessages'))}</a> ${escapeHtml(t('insteadSuffix'))}`
      : escapeHtml(t('unsubscribePromptOnly'));
    body = `<p style="margin:0 0 18px;color:#555;font-size:0.925rem">${lede}</p>
    ${submit('unsubscribeButton')}`;
  }
  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${PUBLIC_PAGE_STYLE}
<title>${escapeHtml(t('unsubscribeTitle'))}</title>
</head>
<body style="margin:0;padding:24px;background:#f4f4f2;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1c1c">
  <main style="max-width:460px;margin:5vh auto;background:#ffffff;border:1px solid #e0e0de;border-radius:12px;padding:28px">
    <h1 style="font-size:1.25rem;margin:0 0 12px">${escapeHtml(t('unsubscribeTitle'))}</h1>
    ${body}
  </main>
</body>
</html>`;
}

/** ADR 0227: the self-contained public preference page (no external assets —
 *  it renders inside any mail-client-opened browser, online or captive). */
/** ADR 0655 D3 — days a preferences link may WIDEN consent (narrowing is forever). */
function preferenceWidenMs(): number { const n = Number(process.env.OPENWOP_EMAIL_PREFERENCE_WIDEN_DAYS ?? 30); return (Number.isFinite(n) && n > 0 ? n : 30) * 86_400_000; }

function renderPreferencesPage(token: string, current: Record<PreferenceChannel, boolean>, state: 'form' | 'saved' | 'partial' | 'refused-stale' | 'refused-suppressed' | 'refused-erased', t: PublicPageT, locale: string): string {
  const action = `/v1/host/openwop-app/public-email/p/${escapeHtml(encodeURIComponent(token))}`;
  const rows = PREFERENCE_CHANNELS.map((ch) => `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #d5d5d5;border-radius:8px;cursor:pointer">
        <input type="checkbox" name="${escapeHtml(ch)}" ${current[ch] ? 'checked' : ''} style="width:18px;height:18px">
        <span>${escapeHtml(t(`channel_${ch}` as PublicPageKey))}</span>
      </label>`).join('\n');
  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${PUBLIC_PAGE_STYLE}
<title>${escapeHtml(t('preferencesTitle'))}</title>
</head>
<body style="margin:0;padding:24px;background:#f4f4f2;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1c1c">
  <main style="max-width:460px;margin:5vh auto;background:#ffffff;border:1px solid #e0e0de;border-radius:12px;padding:28px">
    <h1 style="font-size:1.25rem;margin:0 0 6px">${escapeHtml(t('preferencesTitle'))}</h1>
    <p style="margin:0 0 18px;color:#555;font-size:0.925rem">${escapeHtml(t('preferencesLede'))}</p>
    ${state === 'saved' ? `<p role="status" style="margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#eef6ee;border:1px solid #bcd9bc;color:#1e4620;font-size:0.925rem">${escapeHtml(t('preferencesSaved'))}</p>` : ''}
    ${state === 'refused-stale' || state === 'refused-suppressed' || state === 'refused-erased' ? `<p role="alert" style="margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#fdecea;border:1px solid #f2b8b5;color:#7a1c17;font-size:0.925rem">${escapeHtml(t(state === 'refused-stale' ? 'preferencesRefusedStale' : state === 'refused-erased' ? 'preferencesRefusedErased' : 'preferencesRefusedSuppressed'))}${state === 'refused-erased' ? '' : ` ${escapeHtml(t('preferencesRefusedNextStep'))}`}</p>` : ''}
    ${state === 'partial' ? `<p role="alert" style="margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#fdecea;border:1px solid #f2b8b5;color:#7a1c17;font-size:0.925rem">${escapeHtml(t('preferencesPartial'))}</p>` : ''}
    <form method="post" action="${action}" style="display:flex;flex-direction:column;gap:10px">
      <fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:10px">
        <legend style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">${escapeHtml(t('marketingTypesLegend'))}</legend>
${rows}
      </fieldset>
      <button type="submit" style="margin-top:8px;padding:11px 16px;border:0;border-radius:8px;background:#1c1c1c;color:#ffffff;font-size:0.95rem;cursor:pointer">${escapeHtml(t('savePreferences'))}</button>
    </form>
  </main>
</body>
</html>`;
}
