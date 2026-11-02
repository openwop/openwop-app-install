import type { TFunction } from 'i18next';

/** ADR 1022 (CP71UX-3) — a sync failure reason in words. The ad readers return
 *  a short code (`no_connection`, `http_401`, `timeout`, …) or, for some
 *  platform rejections, the provider's own English text. Known codes get a
 *  translated sentence (a 401/403 is a sign-in problem); anything else gets a
 *  generic translated line that still carries the raw reason for support. */
export function syncReasonText(t: TFunction, reason: string | undefined): string {
  switch (reason ?? '') {
    case 'http_401': case 'http_403': case 'no_connection': return t('campaign-connectors:syncReason_no_connection');
    case 'rate_limited': return t('campaign-connectors:syncReason_rate_limited');
    case 'circuit_open': return t('campaign-connectors:syncReason_circuit_open');
    case 'unsupported': return t('campaign-connectors:syncReason_unsupported');
    case 'timeout': return t('campaign-connectors:syncReason_timeout');
    case 'request_failed': return t('campaign-connectors:syncReason_request_failed');
    case 'bad_response': return t('campaign-connectors:syncReason_bad_response');
    case 'no_developer_token': return t('campaign-connectors:syncReason_no_developer_token');
    case 'invalid_ad_account_id': return t('campaign-connectors:syncReason_invalid_ad_account_id');
    default:
      // A platform 5xx is the platform's fault, not a rejection (CP71UX-15).
      if (/^http_5\d\d$/.test(reason ?? '')) return t('campaign-connectors:syncReason_platform_error');
      return t('campaign-connectors:syncReason_other', { reason: (reason ?? '').slice(0, 160) });
  }
}

/** Which advice fits a failed sync (CP71UX-4, CP71UX-15): wait it out, fix a
 *  setup problem only an admin can, or sign in again. */
export function syncFailureHint(reason: string | undefined): 'wait' | 'setup' | 'signin' {
  const r = reason ?? '';
  if (r === 'rate_limited' || r === 'circuit_open' || r === 'timeout' || /^http_5\d\d$/.test(r)) return 'wait';
  if (r === 'unsupported' || r === 'no_developer_token' || r === 'invalid_ad_account_id') return 'setup';
  return 'signin';
}
