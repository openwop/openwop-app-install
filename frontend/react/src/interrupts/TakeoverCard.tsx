/**
 * ADR 1136 P3a — the browser agent stopped before a step only the person may do
 * (a sign-in), in their own browser window. The person does it there, then
 * continues or stops.
 *
 * What the card shows is the host's, not the model's:
 *  - the page's HOST, from the recorded take-over (the executor's own report of
 *    the page). The surface accepts a "continue" only when this recorded origin
 *    equals the session's, so a card naming a different site authorises nothing;
 *  - the copy is host strings. The step label names a field the PAGE labelled,
 *    so it is shown fenced, as unverified page text;
 *  - nothing here asks for a password: the person types it in the browser
 *    window, never in the app.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { Notice } from '../ui/index.js';
import { resolveByRun } from '../client/interruptsClient.js';
import { decideErrorMessage } from './decideErrorMessage.js';
import { formatDateTime } from '../i18n/format.js';

interface Props {
  runId: string;
  nodeId: string;
  data: unknown;
  onResolved: () => void;
}

export interface TakeoverShown { host: string; label?: string; expiresAt?: string }

/** The take-over fields a card may show, or null when `data` is not one. */
export function takeoverOf(data: unknown): TakeoverShown | null {
  const tk = (data as { computerUseTakeover?: unknown } | null | undefined)?.computerUseTakeover;
  if (!tk || typeof tk !== 'object' || Array.isArray(tk)) return null;
  const t = tk as { origin?: unknown; label?: unknown; expiresAt?: unknown };
  if (typeof t.origin !== 'string') return null;
  let host: string;
  try { host = new URL(t.origin).host; } catch { return null; }
  if (!host) return null;
  return {
    host,
    ...(typeof t.label === 'string' && t.label.trim() ? { label: t.label.trim().slice(0, 120) } : {}),
    ...(typeof t.expiresAt === 'string' && !Number.isNaN(Date.parse(t.expiresAt)) ? { expiresAt: t.expiresAt } : {}),
  };
}

export function TakeoverCard({ runId, nodeId, data, onResolved }: Props): JSX.Element | null {
  const { t } = useTranslation('interrupts');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const tk = takeoverOf(data);
  if (!tk) return null;

  async function answer(action: 'continue' | 'stop') {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await resolveByRun(runId, nodeId, { action });
      onResolved();
    } catch (err) {
      setError(decideErrorMessage(t, err));
      inFlight.current = false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="group" aria-label={t('takeoverTitle', { host: tk.host })} className="u-grid u-gap-2">
      <p className="u-m-0"><strong>{t('takeoverTitle', { host: tk.host })}</strong></p>
      <p className="u-m-0">{t('takeoverBody')}</p>
      {tk.label ? (
        <p className="u-m-0 u-fs-12 muted">
          {t('takeoverPageNote')} <q>{tk.label}</q>
        </p>
      ) : null}
      {tk.expiresAt ? <p className="u-m-0 u-fs-12 muted">{t('takeoverExpires', { time: formatDateTime(tk.expiresAt) })}</p> : null}
      {error && <Notice variant="error" announce={error}>{error}</Notice>}
      <div className="action-bar">
        <Button variant="primary" disabled={busy} onClick={() => { void answer('continue'); }}>{t('takeoverContinue')}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => { void answer('stop'); }}>{t('takeoverStop')}</Button>
      </div>
    </div>
  );
}
