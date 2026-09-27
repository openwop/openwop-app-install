/**
 * ADR 0189 — the connect-to-continue controls, shared by BOTH interrupt
 * render paths so a connection prompt shows the same Connect/Continue/Skip
 * UI everywhere it can surface:
 *   - the chat feed card (`chat/cards/ConnectionRequiredCard`), and
 *   - the run-detail page + cross-run HITL inbox
 *     (`interrupts/ConnectionRequiredDialog` via `RenderInterrupt`).
 *
 * Presentational only: it parses the `data.connection` meta, owns the P9
 * connect launch (`connectionsClient.beginOAuth` / `listProviders` — the card
 * never carries a credential), and calls `onResolve({action, providerId?})`.
 * Each surface supplies its own card shell + heading and adapts `onResolve`
 * to its resume mechanism (chat: `onAction('resolve', …)`; run-detail:
 * `resolveByRun` + `onResolved`). Extracted from the original chat card so the
 * two paths can never drift.
 */
import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { beginOAuth, listProviders } from '../features/connections/connectionsClient.js';
import { Notice } from '../ui/index.js';

interface ConnectionMeta {
  ref?: string;
  providerId?: string;
  category?: string;
  label?: string;
}

export interface ConnectionResumeValue {
  action: 'connected' | 'skip';
  providerId?: string;
}

export function ConnectionRequiredControls({
  data,
  busy,
  onResolve,
}: {
  /** The interrupt's `data` object (carries `connection` meta + `prompt`). */
  data: unknown;
  /** Disable the actions while a resume is in flight. */
  busy?: boolean;
  onResolve: (value: ConnectionResumeValue) => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const d = (data ?? {}) as Record<string, unknown>;
  const meta = (d.connection ?? {}) as ConnectionMeta;
  const providerId = typeof meta.providerId === 'string' ? meta.providerId : undefined;
  const label = meta.label ?? meta.category ?? providerId ?? t('connectionRequiredFallbackLabel');

  // Whether THIS host can run the consent for the named provider (P9
  // oauthConfigured honesty flag). Best-effort: an unreachable catalog or a
  // capability-only prompt (no providerId) falls back to the Access-hub link.
  const [connectable, setConnectable] = useState<boolean | null>(providerId ? null : false);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    void listProviders()
      .then((rows) => { if (!cancelled) setConnectable(rows.find((p) => p.id === providerId)?.oauthConfigured === true); })
      .catch(() => { if (!cancelled) setConnectable(false); });
    return () => { cancelled = true; };
  }, [providerId]);

  async function connect(): Promise<void> {
    if (!providerId) return;
    setLaunching(true);
    setError(null);
    try {
      // Return to THIS surface after consent; the interrupt stays open, and the
      // user clicks "I've connected" to resume.
      const url = await beginOAuth(providerId, window.location.pathname + window.location.search);
      window.location.href = url;
    } catch {
      setError(t('connectionRequiredConnectError'));
      setLaunching(false);
    }
  }

  const prompt = typeof d.prompt === 'string' ? d.prompt : t('connectionRequiredPrompt', { label });

  return (
    <>
      <p className="u-mbox-b2 u-fs-13">{prompt}</p>

      {error ? <Notice variant="error">{error}</Notice> : null}

      {connectable === false && !providerId ? (
        <p className="muted u-fs-12 u-mbox-b2">{t('connectionRequiredCapabilityHint', { label })}</p>
      ) : null}

      <div className="button-row">
        {providerId && connectable !== false ? (
          <Button variant="primary" disabled={busy || launching || connectable === null} onClick={() => { void connect(); }}>
            {launching ? t('connectionRequiredConnecting') : t('connectionRequiredConnect', { label })}
          </Button>
        ) : (
          <a className="btn" href="/access?tab=connections">{t('connectionRequiredManage')}</a>
        )}
        {/* After returning from consent the user confirms; resume re-invokes
            through the backend's own authorization choke point. */}
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => onResolve({ action: 'connected', ...(providerId ? { providerId } : {}) })}
        >
          {t('connectionRequiredContinue')}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={() => onResolve({ action: 'skip' })}>
          {t('connectionRequiredSkip')}
        </Button>
      </div>
    </>
  );
}
