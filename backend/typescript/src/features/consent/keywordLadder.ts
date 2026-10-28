/**
 * ADR 0955 D3 — the ONE inbound keyword ladder for messaging channels (moved from
 * `whatsapp/compliance.ts`, which keeps its behaviour byte for byte).
 *
 * Two halves, so the dependency stays one-way (crm and whatsapp import consent; consent
 * imports neither):
 *  - `classifyKeyword(channel, body)` — which keyword (if any) a message is;
 *  - `applyKeywordConsent(...)` — the CAS consent merge on the given subjects (never
 *    latest-wins: a STOP racing another consent write must not be overwritten).
 * Who the subjects are, and what else a keyword writes (SMS suppression), is the
 * channel owner's decision.
 */
import { createLogger } from '../../observability/logger.js';
import { mergeConsentCategories } from './consentService.js';

const log = createLogger('features.consent.keywords');

export type KeywordChannel = 'whatsapp' | 'sms';
/** `opt-out-all` is SMS STOPALL: every sender in the workspace. `help` writes nothing. */
export type KeywordKind = 'opt-out' | 'opt-out-all' | 'opt-in' | 'help';

/** WhatsApp (ADR 0394): Twilio's default stop words + common variants. */
const WA_STOP_RE = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|parar|baja)\s*$/i;
/** GRADE-CODE 2026-07-17: bare `yes` is not a re-opt-in — only unambiguous subscription verbs. */
const WA_START_RE = /^\s*(start|unstop|subscribe)\s*$/i;

/** SMS (ADR 0955 D3): the CTIA / Twilio standard opt-out and opt-in words. */
const SMS_STOPALL_RE = /^\s*stopall\s*$/i;
const SMS_STOP_RE = /^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i;
const SMS_START_RE = /^\s*(start|unstop)\s*$/i;
const SMS_HELP_RE = /^\s*(help|info)\s*$/i;

export function classifyKeyword(channel: KeywordChannel, body: string): KeywordKind | null {
  if (channel === 'whatsapp') return WA_STOP_RE.test(body) ? 'opt-out' : WA_START_RE.test(body) ? 'opt-in' : null;
  if (SMS_STOPALL_RE.test(body)) return 'opt-out-all';
  if (SMS_STOP_RE.test(body)) return 'opt-out';
  if (SMS_START_RE.test(body)) return 'opt-in';
  if (SMS_HELP_RE.test(body)) return 'help';
  return null;
}

/**
 * Merge `marketing.<channel>` = `optIn` on every subject. An erased subject's write is
 * refused by the consent store (ADR 0657 D10); that is logged, never thrown, because the
 * tombstone already denies every send. Returns how many subjects were written.
 */
export async function applyKeywordConsent(tenantId: string, channel: KeywordChannel, subjects: readonly string[], optIn: boolean, source: string): Promise<number> {
  let written = 0;
  for (const subjectKey of new Set(subjects)) {
    if (!subjectKey) continue;
    try {
      await mergeConsentCategories({ tenantId, subjectKey, categories: { [`marketing.${channel}`]: optIn }, source });
      written += 1;
    } catch (err) {
      if ((err as { code?: string }).code === 'subject_erased') { log.info(`${channel}_keyword_consent_refused_erased`, { tenantId }); continue; }
      throw err;
    }
  }
  return written;
}
