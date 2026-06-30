/**
 * FE-side error → friendly-text lookup table.
 *
 * Companion to the BE's `src/observability/errorRecovery.ts` —
 * `classifyDispatchError()` there returns a richer
 * `{category, action, userMessage, retryAfterMs?}` tuple meant for
 * server-side retry / backoff decisions. This module is the simpler
 * FE-side subset: it only maps `{code, message}` → renderable
 * `{title, detail, action?}` for the ErrorCard component.
 *
 * Why two tables (instead of one shared module)?
 *
 *   The BE classifier takes a raw `Error` (or `AiProviderError`) and
 *   classifies for retry decisions before the error is serialized.
 *   The FE table consumes the already-serialized `{code, message}`
 *   pair that lands on `ChatMessage.meta.error` after surviving the
 *   SSE run-event payload or the HTTP error-envelope round-trip.
 *
 *   When extending the BE classifier with a new code, also add the
 *   matching entry here so the FE doesn't fall through to the
 *   "Something went wrong" default. Drift will manifest as a generic
 *   error card; it won't break the UI.
 *
 * Future consolidation (deferred per the code-review §4 follow-up):
 *   have the BE attach `{category, action, userMessage}` to error
 *   envelopes and SSE error payloads; the FE prefers those when
 *   present and falls back to this table when absent. That's a
 *   payload-shape change so it lands behind a normative RFC; the
 *   FE type `ChatMessage.meta.error` is ALREADY extended (in
 *   `chat/types.ts`) to accept the optional fields so the migration
 *   is FE-side-only when the BE eventually ships them.
 */

import i18n from '../../i18n/index.js';

export interface KnownError {
  title: string;
  detail?: string;
  action?: { kind: 'reconfigure-byok' | 'retry'; label: string };
}

/** Match `<provider>_<status>:` preamble like `anthropic_429: ...`. */
const PROVIDER_STATUS_RE = /^([a-z][a-z0-9-]+)_(\d{3}):/;

type ErrorAction = NonNullable<KnownError['action']>;
const byokAction = (): ErrorAction => ({ kind: 'reconfigure-byok', label: i18n.t('chat:openByokSettings') });
const retryAction = (): ErrorAction => ({ kind: 'retry', label: i18n.t('common:retry') });

export function classifyChatError(error: { code: string; message: string }): KnownError {
  switch (error.code) {
    case 'empty_completion':
      return {
        title: i18n.t('chat:errNoResponseTitle'),
        detail: i18n.t('chat:errNoResponseDetail'),
      };
    case 'credential_unavailable':
    case 'credential_required':
    case 'byok_required':
    case 'byok_required_but_unresolved':
      return {
        title: i18n.t('chat:errApiKeyMissingTitle'),
        detail: i18n.t('chat:errApiKeyMissingDetail'),
        action: byokAction(),
      };
    case 'provider_rate_limited':
      return {
        title: i18n.t('chat:errRateLimitedTitle'),
        detail: i18n.t('chat:errRateLimitedDetail'),
        action: retryAction(),
      };
    case 'provider_unavailable':
      return {
        title: i18n.t('chat:errProviderUnavailableTitle'),
        detail: i18n.t('chat:errProviderUnavailableDetail'),
        action: retryAction(),
      };
    case 'provider_timed_out':
      return {
        title: i18n.t('chat:errProviderTimeoutTitle'),
        detail: i18n.t('chat:errProviderTimeoutDetail'),
        action: retryAction(),
      };
    case 'safety_filter':
    case 'content_filtered':
      return {
        title: i18n.t('chat:errSafetyTitle'),
        detail: i18n.t('chat:errSafetyDetail'),
      };
    case 'structured_output_invalid':
      return {
        title: i18n.t('chat:errInvalidOutputTitle'),
        detail: i18n.t('chat:errInvalidOutputDetail'),
      };
    case 'internal_error': {
      const m = PROVIDER_STATUS_RE.exec(error.message);
      if (!m) {
        return { title: i18n.t('chat:errSomethingWrongTitle'), detail: error.message };
      }
      const provider = m[1] ?? 'provider';
      const status = m[2] ?? '';
      if (status === '429') {
        return {
          title: i18n.t('chat:errRateLimitedTitle'),
          detail: i18n.t('chat:errHttp429Detail', { provider }),
          action: retryAction(),
        };
      }
      if (status === '401' || status === '403') {
        return {
          title: i18n.t('chat:errAuthFailedTitle'),
          detail: i18n.t('chat:errAuthFailedDetail', { provider, status }),
          action: byokAction(),
        };
      }
      if (status.startsWith('5')) {
        return {
          title: i18n.t('chat:errUpstreamTitle'),
          detail: i18n.t('chat:errUpstreamDetail', { provider, status }),
          action: retryAction(),
        };
      }
      return {
        title: i18n.t('chat:errRequestRejectedTitle'),
        detail: i18n.t('chat:errRequestRejectedDetail', { provider, status, message: error.message.slice(error.message.indexOf(':') + 1).trim() }),
      };
    }
    default:
      return { title: i18n.t('chat:errSomethingWrongTitle'), detail: `${error.code}: ${error.message}` };
  }
}
