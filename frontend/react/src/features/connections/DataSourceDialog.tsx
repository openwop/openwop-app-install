/**
 * Data-source dialog (ADR 0783 D1) — sets the base URL a workflow's
 * `data.source.rest` / `data.source.graphql` node calls through this connection,
 * or clears it. The host validates the URL (https, inside the provider's API
 * hosts, no credentials, query or dot segments) and says why when it refuses;
 * that reason is shown inline, beside the field it is about.
 */
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/index.js';
import { classifyHttpError } from '../../client/classifyHttpError.js';
import { writeErrorMessage } from '../../lib/writeAccess.js';
import { setDataSource, type Connection } from './connectionsClient.js';

export function DataSourceDialog({ connection, onSaved, onClose }: {
  connection: Connection;
  onSaved: (message: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('connections');
  const id = useId();
  const current = connection.dataSource?.baseUrl ?? '';
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const close = (): void => { if (!inFlight.current) onClose(); };

  const save = async (next: string | null): Promise<void> => {
    // Keep focus on the aria-disabled controls, but refuse a second submission
    // synchronously, including Enter and a clear racing the pending save.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await setDataSource(connection.connectionId, next);
      onSaved(next === null ? t('dataSourceCleared', { name: connection.displayName }) : t('dataSourceSaved', { name: connection.displayName }));
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      // A 400 is the host's URL rule, phrased for this field; show it as said.
      if (status === 400) setError((err as Error).message || t('dataSourceInvalid'));
      else if (classifyHttpError(err).kind === 'forbidden') setError(writeErrorMessage(t, err));
      else setError(t('dataSourceFailed'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} label={t('dataSourceTitle', { name: connection.displayName })} showClose describedBy={`${id}-hint`}>
      <form className="u-grid u-gap-3" aria-busy={busy || undefined} onSubmit={(e) => { e.preventDefault(); if (value.trim()) void save(value.trim()); }}>
        <h2 className="u-m-0">{t('dataSourceTitle', { name: connection.displayName })}</h2>
        <p id={`${id}-hint`} className="muted u-m-0">{t('dataSourceHint')}</p>
        <label className="u-grid u-gap-1" htmlFor={`${id}-url`}>
          <span className="u-label-sm">{t('dataSourceBaseUrl')}</span>
          <input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            value={value}
            readOnly={busy}
            autoFocus
            autoComplete="off"
            placeholder={t('dataSourcePlaceholder')}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {error ? <p id={`${id}-error`} role="alert" className="u-m-0 u-text-danger">{error}</p> : null}
        <div className="action-bar">
          {current ? (
            <Button variant="quiet" type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) void save(null); }}>{t('dataSourceClear')}</Button>
          ) : null}
          <Button variant="secondary" type="button" aria-disabled={busy || undefined} onClick={close}>{t('common:cancel')}</Button>
          <Button variant="primary" type="submit" aria-disabled={busy || !value.trim() || undefined}>{t('dataSourceSave')}</Button>
        </div>
      </form>
    </Modal>
  );
}
