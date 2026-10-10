/**
 * Structured error card for a failed assistant turn.
 *
 * Replaces the raw `<strong>code:</strong> message` line with a
 * neutral card carrying a friendly headline, the underlying code +
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

import { Button } from '../ui/Button.js';
import { AlertIcon } from '../ui/icons/index.js';
import { SignInButton } from '../auth/SignInButton.js';
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
  if (envelope.action === 'sign_in') return { kind: 'sign-in', label: i18n.t('auth:signIn', { defaultValue: 'Sign in' }) };
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
  // DESIGN.md §3 rule 3 / §4.6 — a neutral surface with the failure named by an
  // icon + a danger-tinted TITLE, plain words below, the fix as a real button,
  // and the wire code behind "Technical details" (kept for support, not shown
  // as the message). One place: ConversationView no longer echoes this text in
  // a second banner.
  return (
    <div role="alert" className="errcard-root">
      <div className="errcard-title">
        <AlertIcon size={16} aria-hidden />
        <span>{k.title}</span>
      </div>
      {k.detail && <div className="errcard-detail">{k.detail}</div>}
      <div className="errcard-foot">
        {k.action?.kind === 'reconfigure-byok' && onReconfigure && (
          <Button variant="secondary" size="sm" onClick={onReconfigure}>
            {k.action.label}
          </Button>
        )}
        {/* Signing in is the fix; a person's own key is the other way through,
            so the key settings ride along when the surface can open them. */}
        {k.action?.kind === 'sign-in' && <SignInButton />}
        {k.action?.kind === 'sign-in' && onReconfigure && (
          <Button variant="quiet" size="sm" onClick={onReconfigure}>
            {i18n.t('chat:openByokSettings')}
          </Button>
        )}
        {k.action?.kind === 'retry' && onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {k.action.label}
          </Button>
        )}
        <details className="errcard-tech">
          <summary>{i18n.t('chat:errTechnicalDetails')}</summary>
          <code>{error.code}</code>
        </details>
      </div>
    </div>
  );
}
