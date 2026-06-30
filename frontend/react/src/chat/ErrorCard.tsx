/**
 * Structured error card for a failed assistant turn.
 *
 * Replaces the raw `<strong>code:</strong> message` line with a
 * red-bordered card carrying a friendly headline, the underlying code +
 * provider context (when known), and a primary suggested action.
 *
 * Two layers of classification:
 *
 *  1. **BE-attached** — when `error.userMessage` / `error.action` are
 *     present on the envelope (a BE that has wired
 *     `classifyDispatchError()` into its error pipeline), we render
 *     those directly. The BE wins ties because it's seen the raw
 *     `Error` instance with its full stack + provider context.
 *
 *  2. **FE fallback** — otherwise we run the `{code, message}` pair
 *     through `chat/lib/errorClassify.ts:classifyChatError()` which
 *     produces a renderable `{title, detail, action?}` triple.
 *
 * role="alert" so screen readers announce the failure on first paint.
 */

import i18n from '../i18n/index.js';
import { classifyChatError, type KnownError } from './lib/errorClassify.js';
import type { ChatMessage } from './types.js';

type ErrorEnvelope = NonNullable<NonNullable<ChatMessage['meta']>['error']>;

interface Props {
  error: ErrorEnvelope;
  /** Open the BYOK wizard. Wired from ChatSidebar / ChatTab. When absent
   *  the `reconfigure-byok` action falls back to descriptive text only. */
  onReconfigure?: () => void;
  /** Re-run the prior user message that produced this error. */
  onRetry?: () => void;
}

/** Map a BE-attached `RecoveryAction` to the FE button-action vocabulary
 *  ErrorCard can wire callbacks to. Unmapped actions surface as a plain
 *  card without a button. */
function actionFromBE(envelope: ErrorEnvelope): KnownError['action'] {
  if (envelope.action === 'reconfigure') return { kind: 'reconfigure-byok', label: i18n.t('chat:openByokSettings') };
  if (envelope.action === 'retry' || envelope.action === 'wait') return { kind: 'retry', label: i18n.t('common:retry') };
  // 'regenerate' / 'abort' have no FE button affordance in this card.
  return undefined;
}

function classify(error: ErrorEnvelope): KnownError {
  // Prefer BE-attached fields when present.
  if (error.userMessage) {
    return {
      title: error.userMessage,
      ...(actionFromBE(error) ? { action: actionFromBE(error)! } : {}),
    };
  }
  return classifyChatError(error);
}

export function ErrorCard({ error, onReconfigure, onRetry }: Props): JSX.Element {
  const k = classify(error);
  return (
    <div role="alert" className="errcard-root">
      <div className="u-fw-600 u-text-danger">{k.title}</div>
      {k.detail && <div className="u-mt-1 u-ink">{k.detail}</div>}
      <div className="muted u-mt-1-5 u-fs-11 u-o-70">
        {error.code}
      </div>
      {k.action && (
        <div className="u-mt-2">
          {k.action.kind === 'reconfigure-byok' && onReconfigure && (
            <button
              type="button"
              className="secondary errcard-action-btn"
              onClick={onReconfigure}
            >
              {k.action.label}
            </button>
          )}
          {k.action.kind === 'retry' && onRetry && (
            <button
              type="button"
              className="secondary errcard-action-btn"
              onClick={onRetry}
            >
              {k.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
