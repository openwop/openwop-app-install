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
  action?: { kind: 'reconfigure-byok' | 'retry' | 'sign-in'; label: string };
}

/** Match a `<provider>_<status>:` marker like `anthropic_429: ...`. Found
 *  ANYWHERE in the message, not only at its start: the conversation lane wraps
 *  it ("Conversation reply failed: openai_401: {…}"), and an anchored match let
 *  that raw provider JSON through as the card's detail. */
const PROVIDER_STATUS_RE = /(?:^|[\s:])([a-z][a-z0-9-]+)_(\d{3}):/;

type ErrorAction = NonNullable<KnownError['action']>;
const byokAction = (): ErrorAction => ({ kind: 'reconfigure-byok', label: i18n.t('chat:openByokSettings') });
const retryAction = (): ErrorAction => ({ kind: 'retry', label: i18n.t('common:retry') });

/** The free tier refuses anonymous callers when the host requires sign-in
 *  (`OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED`, on for app.openwop.dev). The run
 *  route carries `sign_in_required` as the code; the conversation lane wraps it
 *  as `internal_error` with the provider's sentence, so the sentence is the
 *  fallback signal until the code survives that hop. */
const SIGN_IN_REQUIRED_RE = /sign in to use the free tier/i;

export function classifyChatError(error: { code: string; message: string; reason?: string }): KnownError {
  if (error.code === 'sign_in_required' || error.reason === 'sign_in_required' || SIGN_IN_REQUIRED_RE.test(error.message)) {
    return {
      title: i18n.t('chat:errSignInTitle'),
      detail: i18n.t('chat:errSignInDetail'),
      action: { kind: 'sign-in', label: i18n.t('auth:signIn', { defaultValue: 'Sign in' }) },
    };
  }
  // The free tier's DAILY allowance. It reaches the chat as a generic failure
  // code with this reason; retrying cannot help until 00:00 UTC, so the card
  // offers the one thing that does: the user's own key.
  if (error.reason === 'daily_limit_reached') {
    return {
      title: i18n.t('chat:errDailyLimitTitle'),
      detail: i18n.t('chat:errDailyLimitDetail'),
      action: byokAction(),
    };
  }
  switch (error.code) {
    // ADR 0482 (ux-1) — a workflow dispatch rejected by the owner-set daily
    // budget. The wrapper (useWorkflowRunMentions) passes the machine-readable
    // envelope reason through; a reasonless dispatch_failed stays generic.
    case 'dispatch_failed':
      if (error.reason === 'workflow_budget_exhausted') {
        return {
          title: i18n.t('common:errorBudgetTitle'),
          detail: i18n.t('common:errorBudgetDetail'),
        };
      }
      return { title: i18n.t('chat:errSomethingWrongTitle'), detail: error.message };
    case 'empty_completion':
      return {
        title: i18n.t('chat:errNoResponseTitle'),
        detail: i18n.t('chat:errNoResponseDetail'),
        // AB-R2-1 — a regenerate is free of side effects here (nothing was
        // produced), so the card offers it instead of dead-ending.
        action: retryAction(),
      };
    // A host policy refusal carries one wire code for every mode; a
    // `required`-mode refusal names the missing key in `reason`
    // (capabilities.md "Wire-format error"). Any other reason stays generic.
    case 'provider_policy_denied':
      if (error.reason !== 'byok_required' && error.reason !== 'byok_required_but_unresolved') {
        return { title: i18n.t('chat:errSomethingWrongTitle'), detail: `${error.code}: ${error.message}` };
      }
      return {
        title: i18n.t('chat:errApiKeyMissingTitle'),
        detail: i18n.t('chat:errApiKeyMissingDetail'),
        action: byokAction(),
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
    // The conversation run lost its gate (or it was already resolved, or the
    // run is gone). The user's message is saved; the transport has already
    // dropped the dead run, so sending again opens a fresh conversation. Say
    // that in plain words — the wire code stays behind "Technical details".
    case 'interrupt_not_found':
    case 'interrupt_gone':
    case 'interrupt_already_resolved':
    case 'run_not_found':
      return {
        title: i18n.t('chat:errReplyLostTitle'),
        detail: i18n.t('chat:errReplyLostDetail'),
        action: { kind: 'retry', label: i18n.t('chat:errSendAgain') },
      };
    // Track-3 i18n — the conversation gate-open timeouts (conversationTransport).
    case 'conversation_start_timeout':
      return {
        title: i18n.t('chat:errConvStartTimeoutTitle'),
        detail: i18n.t('chat:errConvStartTimeoutDetail'),
        action: retryAction(),
      };
    case 'conversation_gate_timeout':
      return {
        title: i18n.t('chat:errConvGateTimeoutTitle'),
        detail: i18n.t('chat:errConvGateTimeoutDetail'),
        action: retryAction(),
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
        // AB-R2-1 (UX_UPGRADE-app-builder R3) — the AI-AUTHORING failure class.
        // The backend already runs the bounded error-fed repair on authoring
        // paths; when even that surfaces here, the turn used to dead-end with
        // no affordance (the Lovable "try to fix" gap). Retry re-runs the
        // prior user turn through the same repair loop. `safety_filter` /
        // `content_filtered` stay action-less DELIBERATELY — re-running
        // filtered content is not a fix.
        action: retryAction(),
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
        detail: i18n.t('chat:errRequestRejectedDetail', { provider, status, message: error.message.slice(m.index + m[0].length).trim() }),
      };
    }
    default:
      return { title: i18n.t('chat:errSomethingWrongTitle'), detail: `${error.code}: ${error.message}` };
  }
}
