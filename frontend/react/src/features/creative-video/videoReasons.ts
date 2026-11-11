/**
 * The i18n key of the reason for a creative-video failure code (ADR 1051 D11).
 */

/** The reasons a person can act on, by the server's code. A
 *  provider's own status (`heygen_400`, `t2v_404`) and a refused result URL are
 *  grouped; anything unknown gets the generic line, never the raw code. */
const KNOWN_REASONS = ['no_connection', 'budget_exceeded', 'video_budget_disabled', 'submit_unconfirmed', 'provider_failed', 'capacity_exceeded', 'video_too_large', 'likeness_consent_required', 'validation_error', 'forbidden_scope'] as const;
export function reasonKey(code: string | undefined): string {
  if (!code) return 'reason_unknown';
  if ((KNOWN_REASONS as readonly string[]).includes(code)) return `reason_${code}`;
  if (code.startsWith('t2v_invalid_')) return 'reason_validation_error'; // refused by the host's model table, pre-dial
  if (/^(heygen|t2v)_\d{3}$/.test(code)) return 'reason_provider_rejected';
  if (code.startsWith('video_result_url_') || code.startsWith('download_')) return 'reason_download_refused';
  return 'reason_unknown';
}
