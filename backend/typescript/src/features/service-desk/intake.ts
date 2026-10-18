/**
 * ADR 0422 P2 — omnichannel intake on EXISTING seams (never new webhook
 * machinery):
 *  - WhatsApp: an ADR 0394 verified-inbound observer (appended alongside the
 *    window-ledger observer via the P2 multi-observer seam upgrade) files each
 *    sender's messages onto ONE continuous ticket keyed
 *    `wa:<connectionId>:<from>` (find-or-create; provider retries dedupe by
 *    message id; a reply after solve re-opens — the P1 semantics).
 *  - Forms: an ADR 0330 SubmissionSink registered AFTER the CRM sink so it
 *    reuses the sink chain's `contactId` marker.
 *  - Contact attach: phone/email resolve via the OWNING identity module
 *    (cdp.resolveIdentity — the same delegation cdp itself makes into crm).
 *
 * WhatsApp intake requires explicit per-tenant configuration (the default intake
 * org) — unconfigured tenants no-op with a debug log (fail QUIET, never a guessed
 * org; the ADR's honest-configuration rule). FORM intake does not use that org
 * (ADR 0850 D1): a form files a ticket only when it opted in (`createTicket`),
 * into its own org, while `service-desk` is on; the config supplies SLA hours.
 */
import { createLogger } from '../../observability/logger.js';
import { resolveToggle } from '../../host/featureToggles/service.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerInboundObserver } from '../connections/inboundWebhooks.js';
import { extractWaInbound, normalizeWaNumber } from '../whatsapp/whatsappService.js';
import { ownerPublicRuntimeLapsed } from '../../host/publicLapse.js';
import { registerSubmissionSink } from '../forms/submissionSinks.js';
import { resolveIdentity } from '../cdp/identityService.js';
import { createTicket } from './tickets.js';
import { OpenwopError } from '../../types.js';

const log = createLogger('service-desk.intake');

export interface IntakeConfig {
  tenantId: string;
  /** The org new intake tickets file under. Explicit — never guessed. */
  defaultOrgId: string;
  /** Optional per-priority SLA hours (0 disables the clock for a priority). */
  slaHoursByPriority?: Partial<Record<'low' | 'normal' | 'high' | 'urgent', number>>;
  updatedBy: string;
  updatedAt: string;
}

export const intakeConfigs = new DurableCollection<IntakeConfig>(
  'service-desk:config',
  (c) => c.tenantId,
  undefined,
  (c) => c.tenantId,
);

export async function getIntakeConfig(tenantId: string): Promise<IntakeConfig | null> {
  const c = await intakeConfigs.get(tenantId);
  return c && c.tenantId === tenantId ? c : null;
}

/** Write the tenant's intake config. ADR 0878 D2: an absent `slaHoursByPriority`
 *  KEEPS the stored table — the old PUT silently dropped it, so no SLA override
 *  ever survived a save. */
export async function setIntakeConfig(tenantId: string, defaultOrgId: string, updatedBy: string, slaHoursByPriority?: Partial<Record<'low' | 'normal' | 'high' | 'urgent', number>>): Promise<IntakeConfig> {
  const prior = await getIntakeConfig(tenantId);
  const sla = slaHoursByPriority ?? prior?.slaHoursByPriority;
  const cfg: IntakeConfig = { tenantId, defaultOrgId, ...(sla ? { slaHoursByPriority: sla } : {}), updatedBy, updatedAt: new Date().toISOString() };
  await intakeConfigs.put(cfg);
  return cfg;
}

/** ADR 0878 D2 — validate an operator's SLA table: integer hours 0–720 per known
 *  priority (0 disables that priority's clock). Anything else is a typed 422. */
export function parseSlaHours(raw: unknown): Partial<Record<'low' | 'normal' | 'high' | 'urgent', number>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', '`slaHoursByPriority` must be an object of priority → hours.', 422, { field: 'slaHoursByPriority' });
  }
  const out: Partial<Record<'low' | 'normal' | 'high' | 'urgent', number>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k !== 'low' && k !== 'normal' && k !== 'high' && k !== 'urgent') {
      throw new OpenwopError('validation_error', `Unknown priority \`${k}\` in slaHoursByPriority.`, 422, { field: 'slaHoursByPriority' });
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 720) {
      throw new OpenwopError('validation_error', `SLA hours for \`${k}\` must be a whole number from 0 to 720.`, 422, { field: 'slaHoursByPriority' });
    }
    out[k] = v;
  }
  return out;
}

/** Best-effort contact resolution via the owning identity module.
 *  Deliberately the UNMASKED resolver (CLNP-3): only the opaque `contactId` is read and
 *  nothing else leaves this function or is persisted. If you ever return or store more
 *  of `golden`, switch to `resolveIdentityWithAccess` like `cdp/surface.ts` did. */
async function contactIdFor(tenantId: string, type: 'phone' | 'email', value: string): Promise<string | undefined> {
  try {
    const golden = await resolveIdentity(tenantId, type, value);
    const id = (golden as { contact?: { contactId?: string } } | null)?.contact?.contactId;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined; // identity resolution is enrichment — never blocks intake
  }
}

/** The WhatsApp verified-inbound observer (both BSP transports). */
export async function onWhatsAppInboundForTickets(event: { tenantId: string; connectionId: string; body: Record<string, unknown> }): Promise<void> {
  // ADR 0878 D9 (SD2-S7) — this lane read NO toggle: with Service desk off it kept
  // filing tickets and arming SLA clocks. The sender is not a member (a PUBLIC
  // lane, tenant from the verified connection), so it reads the toggle only — the
  // ADR 0819 visitor opt-out — plus the owner-lapse policy, exactly as the widget.
  const desk = await resolveToggle('service-desk', { tenantId: event.tenantId }).catch(() => null);
  if (desk?.enabled !== true || (await ownerPublicRuntimeLapsed('service-desk', event.tenantId))) {
    log.debug('service-desk off — whatsapp message not ticketed', { tenantId: event.tenantId });
    return;
  }
  const cfg = await getIntakeConfig(event.tenantId);
  if (!cfg) {
    log.debug('service-desk intake unconfigured — whatsapp message not ticketed', { tenantId: event.tenantId });
    return;
  }
  for (const [i, msg] of extractWaInbound(event.body).entries()) {
    // Twilio's sender is `whatsapp:+E164`; store and match the bare E.164 (ADR 0878 D4).
    const phone = normalizeWaNumber(msg.from);
    const contactId = await contactIdFor(event.tenantId, 'phone', phone ?? msg.from);
    // Provider payloads carry a stable message id on Cloud API; Twilio's form
    // POST carries MessageSid. Fall back to a content-deterministic id so a
    // provider RETRY of the same body stays idempotent.
    const body = event.body as { MessageSid?: unknown };
    const providerMsgId = typeof body.MessageSid === 'string' ? body.MessageSid : undefined;
    await createTicket({
      tenantId: event.tenantId,
      orgId: cfg.defaultOrgId,
      subject: `WhatsApp: ${msg.text.slice(0, 80) || msg.from}`,
      channel: 'whatsapp',
      ...(cfg.slaHoursByPriority ? { slaHoursByPriority: cfg.slaHoursByPriority } : {}),
      ...(contactId ? { contactId } : {}),
      // The key keeps the RAW sender so a thread opened before ADR 0878 continues.
      externalKey: `wa:${event.connectionId}:${msg.from}`,
      // ADR 0878 D3 — where a reply goes. Backfilled onto an existing thread.
      replyChannel: { kind: 'whatsapp', connectionId: event.connectionId },
      ...(phone ? { requester: { phone } } : {}),
      firstMessage: {
        messageId: providerMsgId ?? `wa:${msg.from}:${hashText(msg.text)}:${i}`,
        body: msg.text,
        author: contactId ? `contact:${contactId}` : `wa:${phone ?? msg.from}`,
        direction: 'inbound',
      },
      createdBy: 'system:service-desk',
    }).catch((err) => log.warn('whatsapp ticket intake failed', { tenantId: event.tenantId, error: err instanceof Error ? err.message : String(err) }));
  }
}

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Register the intake lanes (called from feature registration; idempotent). */
export function registerServiceDeskIntake(): void {
  registerInboundObserver('whatsapp-twilio', onWhatsAppInboundForTickets);
  registerInboundObserver('whatsapp-cloud', onWhatsAppInboundForTickets);

  registerSubmissionSink({
    id: 'service-desk-ticket',
    async onSubmission(form, submission) {
      // ADR 0850 D1 (user decision 2026-10-07) — a ticket is filed only for a form
      // that OPTED IN (`createTicket`, default off), and only in THAT form's own
      // org. This used to file EVERY submission in the tenant into the one org an
      // admin named in the intake config, values verbatim — so that org's members
      // read other orgs' private-form leads. The intake config no longer decides
      // WHERE a form lead goes; it still names the org for the channels that carry
      // none (WhatsApp, the widget) and supplies the SLA hours.
      if (!form.createTicket || submission.orgId !== form.orgId) return undefined;
      // ADR 0819 §1 opt-out — a PUBLIC lane (tenant from the resource): the visitor is never paywalled on the operator's plan.
      const desk = await resolveToggle('service-desk', { tenantId: submission.tenantId });
      if (!desk || !desk.enabled) return undefined; // FRMWF-13 — the only sink that read no toggle
      const cfg = await getIntakeConfig(submission.tenantId);
      const values = (submission.values ?? {}) as Record<string, unknown>;
      const email = typeof values.email === 'string' ? values.email : '';
      // Reuse the chain's contact marker when the CRM sink (registered before
      // us) resolved one; else best-effort by the submitted email.
      const contactId = submission.contactId ?? (email ? await contactIdFor(submission.tenantId, 'email', email) : undefined);
      const summary = Object.entries(values)
        .filter(([, v]) => typeof v === 'string' && v)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`)
        .join('\n')
        .slice(0, 4000);
      await createTicket({
        tenantId: submission.tenantId,
        orgId: form.orgId,
        subject: `Form: ${form.title || form.formId}`.slice(0, 300),
        channel: 'form',
        ...(cfg?.slaHoursByPriority ? { slaHoursByPriority: cfg.slaHoursByPriority } : {}),
        ...(contactId ? { contactId } : {}),
        // ADR 0878 D4 — the requester's address, so a DSAR keyed on it reaches this
        // thread even when no CRM contact resolved. No reply channel: a form ticket
        // has no outbound lane yet (email delivery is SD2-F1).
        ...(email ? { requester: { email } } : {}),
        externalKey: `form:${submission.submissionId}`,
        firstMessage: {
          messageId: `form:${submission.submissionId}`,
          body: summary || '(empty submission)',
          author: contactId ? `contact:${contactId}` : 'visitor',
          direction: 'inbound',
        },
        createdBy: 'system:service-desk',
      });
      return undefined; // enrichment sink — never claims the contact slot
    },
  });
}
