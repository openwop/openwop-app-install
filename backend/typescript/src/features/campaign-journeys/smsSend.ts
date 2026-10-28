/**
 * ADR 0955 D4 + D2 — what a journey SMS send needs to know before it calls the egress:
 * may this client's sender text this contact NOW, from which number, and if not, why.
 *
 * Every answer is a typed refusal the `send-sms` node turns into a typed failure (J955WF-4 —
 * never success with `sent:false`). The exit guard at `host/smsAdapter.ts` still re-checks
 * STOP for every caller; this is the journey's earlier, richer answer, not a replacement.
 */
import { getContact } from '../crm/contactsService.js';
import { checkChannelEligibility, type ChannelIneligibleReason } from '../crm/channelEligibility.js';
import { listSmsSenders } from '../crm/smsSenders.js';
import { tenantMayUseFeature } from '../../host/tenantFeatureGate.js';
import { resolveEnrollmentOrg } from './journeyService.js';
import { getSendPolicy, nextSendWindow, zonesFor, type WindowChannel, type ZoneResolution } from './sendPolicy.js';
import { getTemplateVersion } from '../email/emailService.js';
import { smsBodyProblem } from '../../host/smsText.js';

/** ADR 0941 D5 — the sub-toggle id; AND-gated in code with its parent and `consent`. */
export const JOURNEY_SMS_TOGGLE = 'campaign-journeys.sms';

export type SendWindowAnswer =
  | { inWindow: boolean; resumeAt: string; zones: string[]; basis: ZoneResolution['basis'] }
  | { inWindow: false; reason: 'timezone_unknown' | 'window_unreachable' | 'contact_not_found'; zones: string[]; basis: ZoneResolution['basis'] };

export async function checkSendWindow(tenantId: string, orgId: string, contactId: string, channel: WindowChannel, now: Date = new Date()): Promise<SendWindowAnswer> {
  const o = await resolveEnrollmentOrg(tenantId, orgId);
  const contact = await getContact(contactId);
  if (!contact || contact.tenantId !== tenantId) return { inWindow: false, reason: 'contact_not_found', zones: [], basis: 'unknown' };
  const policy = await getSendPolicy(tenantId, o);
  const window = policy.windows[channel];
  const res = zonesFor({ contactTimezone: contact.customFields?.timezone, ...(policy.defaultTimezone ? { defaultTimezone: policy.defaultTimezone } : {}), ...(contact.phone ? { phone: contact.phone } : {}) });
  if (!window) return { inWindow: true, resumeAt: now.toISOString(), zones: res.zones, basis: res.basis };
  if (res.zones.length === 0) return { inWindow: false, reason: 'timezone_unknown', zones: [], basis: res.basis };
  const next = nextSendWindow({ now, window, zones: res.zones });
  if (!next) return { inWindow: false, reason: 'window_unreachable', zones: res.zones, basis: res.basis };
  return { inWindow: next.getTime() === now.getTime(), resumeAt: next.toISOString(), zones: res.zones, basis: res.basis };
}

export type SmsSendRefusal =
  | { ok: false; code: 'sms_disabled' }
  | { ok: false; code: 'not_eligible'; reason: ChannelIneligibleReason }
  | { ok: false; code: 'quiet_hours'; resumeAt?: string }
  | { ok: false; code: 'timezone_unknown' | 'window_unreachable' | 'no_sender' };

export async function smsSendContext(
  tenantId: string,
  orgId: string,
  contactId: string,
  opts: { purpose?: 'marketing' | 'transactional'; topicId?: string; now?: Date } = {},
): Promise<{ ok: true; to: string; from: string; name: string } | SmsSendRefusal> {
  const now = opts.now ?? new Date();
  // ADR 0941 D5 — the sub-toggle is a capability (on adds the ability), checked with its
  // parent and consent. The STOP observer and the exit guard are never gated.
  for (const id of [JOURNEY_SMS_TOGGLE, 'campaign-journeys', 'consent']) {
    if (!(await tenantMayUseFeature(id, tenantId))) return { ok: false, code: 'sms_disabled' };
  }
  const o = await resolveEnrollmentOrg(tenantId, orgId);
  const elig = await checkChannelEligibility(tenantId, o, contactId, 'sms', {
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
    ...(opts.topicId ? { topicId: opts.topicId } : {}),
    ...(orgId ? { topicOrgId: orgId } : {}),
  });
  if (!elig.eligible) return { ok: false, code: 'not_eligible', reason: elig.reason };
  if ((opts.purpose ?? 'marketing') === 'marketing') {
    const w = await checkSendWindow(tenantId, orgId, contactId, 'sms', now);
    if ('reason' in w) return w.reason === 'contact_not_found' ? { ok: false, code: 'not_eligible', reason: 'contact_not_found' } : { ok: false, code: w.reason };
    if (!w.inWindow) return { ok: false, code: 'quiet_hours', resumeAt: w.resumeAt };
  }
  // The client's own number, deterministically (architect P2 finding 4): never another
  // client's sender, never "any number of the workspace".
  const sender = (await listSmsSenders(tenantId)).filter((b) => (b.orgId ?? '') === o).map((b) => b.number).sort()[0];
  if (!sender) return { ok: false, code: 'no_sender' };
  return { ok: true, to: elig.address, from: sender, name: elig.name };
}

/**
 * ADR 0955 D8 — a journey SMS body from the ADR 0905 template store: a PINNED version (never
 * the live template), of an SMS template, owned by the org the journey named. The same body
 * rules the store applied at write are applied again here (a refusal is typed, never a send).
 */
export async function smsTemplateBody(tenantId: string, orgId: string, templateId: string, version: number):
  Promise<{ ok: true; text: string; templateVersion: number; contentHash: string } | { ok: false; code: 'template_not_found' | 'template_format' | 'sms_body_invalid'; message: string }> {
  const v = orgId && templateId ? await getTemplateVersion(tenantId, orgId, templateId, version) : null;
  if (!v) return { ok: false, code: 'template_not_found', message: 'No such template version for this client.' };
  if (v.format !== 'sms') return { ok: false, code: 'template_format', message: 'This is an email template; a journey text needs an SMS template.' };
  const problem = smsBodyProblem(v.body);
  if (problem) return { ok: false, code: 'sms_body_invalid', message: problem };
  return { ok: true, text: v.body, templateVersion: v.version, contentHash: v.contentHash };
}
