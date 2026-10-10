/**
 * ADR 0799 — approve a CLI sign-in. `openwop login` shows a short code; the
 * person types it here, sees what is asking, and approves or denies. The code
 * is TYPED, never carried in a link: a link that carried it would let anyone
 * who started a sign-in mail it to a victim.
 */
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { TerminalIcon } from '../../ui/icons/index.js';
import { announce } from '../../ui/announce.js';
import { classifyHttpError } from '../../client/classifyHttpError.js';
import { writeErrorMessage } from '../../lib/writeAccess.js';
import { useFormat } from '../../i18n/useFormat.js';
import { decideCliLogin, getCliLoginRequest, type CliLoginRequest } from './apiKeysClient.js';

export function CliLoginCard({ onApproved }: { onApproved: () => void }): JSX.Element {
  const { t } = useTranslation('developer-keys');
  const fmt = useFormat();
  const codeId = useId();
  const errorId = useId();
  const codeRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [found, setFound] = useState<CliLoginRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const lookUp = async (): Promise<void> => {
    if (!code.trim()) { setError(t('cliCodeRequired')); codeRef.current?.focus(); return; }
    setBusy(true); setError(null); setDone(null);
    try {
      setFound((await getCliLoginRequest(code.trim())).request);
    } catch (err) {
      setFound(null);
      // A wrong, expired or already-used code all read the same, on purpose.
      setError(classifyHttpError(err).kind === 'not-found' ? t('cliCodeUnknown') : writeErrorMessage(t, err));
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    if (!found) return;
    setBusy(true); setError(null);
    try {
      await decideCliLogin(found.userCode, decision);
      const message = decision === 'approve' ? t('cliApproved', { label: found.label }) : t('cliDenied', { label: found.label });
      setDone(message);
      announce(message);
      setFound(null);
      setCode('');
      if (decision === 'approve') onApproved();
    } catch (err) {
      setError(classifyHttpError(err).kind === 'not-found' ? t('cliCodeUnknown') : writeErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="surface-card">
      <h2 className="u-flex u-items-center u-gap-2"><TerminalIcon size={18} /> {t('cliLoginTitle')}</h2>
      <p className="muted">{t('cliLoginHelp')}</p>
      {!found ? (
        <form className="mcp-key-form" noValidate onSubmit={(e) => { e.preventDefault(); void lookUp(); }}>
          <div className="field">
            <label htmlFor={codeId}>{t('cliCodeLabel')}</label>
            <input
              id={codeId}
              ref={codeRef}
              value={code}
              maxLength={16}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ABCD-EFGH"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => { setCode(e.target.value); if (error) setError(null); }}
            />
            {error && <p id={errorId} className="field-error" role="alert">{error}</p>}
          </div>
          <div className="action-bar">
            <Button type="submit" variant="secondary" loading={busy}>{t('cliCodeCheck')}</Button>
          </div>
        </form>
      ) : (
        <div className="mcp-issued" role="region" aria-label={t('cliRequestRegion')}>
          <Notice variant="warning">{t('cliConfirm', { label: found.label })}</Notice>
          <p className="muted u-fs-13">
            {t('cliRequestMeta', { code: found.userCode, from: found.requestedFrom, time: fmt.time(found.createdAt) })}
          </p>
          <p className="muted u-fs-13">{t('cliRequestWarning')}</p>
          <div className="action-bar">
            <Button variant="primary" size="sm" loading={busy} onClick={() => void decide('approve')}>{t('cliApprove')}</Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => void decide('deny')}>{t('cliDeny')}</Button>
          </div>
          {error && <Notice variant="error" announce={error}>{error}</Notice>}
        </div>
      )}
      {done && <Notice variant="info">{done}</Notice>}
    </div>
  );
}
