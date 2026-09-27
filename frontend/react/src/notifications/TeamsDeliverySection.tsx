/**
 * Teams approval-delivery section (ADR 0198 Phase B) — self-service. Choose a
 * Microsoft 365 connection + a Teams chat id to receive your approval requests
 * as adaptive cards. Deciding still happens in-app; the card is a "Review in
 * OpenWOP" deep link. Shows nothing actionable until you have a microsoft365
 * connection (deploy-gated per ADR 0033 — honest, not a dead form).
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { toast } from '../ui/toast.js';
import { listConnections, type Connection } from '../features/connections/connectionsClient.js';
import {
  getTeamsDeliveryPref,
  setTeamsDeliveryPref,
  clearTeamsDeliveryPref,
} from './teamsDeliveryClient.js';

export function TeamsDeliverySection(): JSX.Element | null {
  const { t } = useTranslation('notifications');
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [chatId, setChatId] = useState('');
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [conns, pref] = await Promise.all([listConnections(), getTeamsDeliveryPref()]);
      setConnections(conns.filter((c) => c.provider === 'microsoft365'));
      if (pref) {
        setConnectionId(pref.connectionId);
        setChatId(pref.chatId);
        setConfigured(true);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = useCallback(async () => {
    if (!connectionId || !chatId.trim()) return;
    setBusy(true);
    try {
      await setTeamsDeliveryPref({ connectionId, chatId: chatId.trim() });
      setConfigured(true);
      toast.success(t('teamsDeliverySaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('teamsDeliverySaveFailed'));
    } finally {
      setBusy(false);
    }
  }, [connectionId, chatId, t]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await clearTeamsDeliveryPref();
      setConfigured(false);
      setChatId('');
      toast.success(t('teamsDeliveryDisabled'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('teamsDeliveryDisableFailed'));
    } finally {
      setBusy(false);
    }
  }, [t]);

  // Deploy-gated honesty: hide the section until we KNOW a microsoft365
  // connection exists — `null` (still loading) and `[]` (none) both hide, so
  // there is no flash of a form that can't work (ADR 0033). The section pops
  // in once a connection is confirmed.
  if (!connections || connections.length === 0) return null;

  return (
    <section className="surface-card" aria-labelledby="teams-delivery-heading">
      <h3 id="teams-delivery-heading">{t('teamsDeliveryHeading')}</h3>
      <p className="muted u-fs-13">{t('teamsDeliveryLede')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {configured ? <p className="chip chip--success">{t('teamsDeliveryActive')}</p> : null}

      <div className="delegation-form">
        <label>
          <span>{t('teamsDeliveryConnection')}</span>
          <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">{t('teamsDeliveryChoose')}</option>
            {(connections ?? []).map((c) => (
              <option key={c.connectionId} value={c.connectionId}>{c.displayName}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('teamsDeliveryChatId')}</span>
          <input
            type="text"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder={t('teamsDeliveryChatPlaceholder')}
          />
        </label>
        <Button variant="primary" disabled={busy || !connectionId || !chatId.trim()} onClick={() => { void save(); }}>
          {t('teamsDeliverySave')}
        </Button>
        {configured ? (
          <Button variant="secondary" disabled={busy} onClick={() => { void disable(); }}>
            {t('teamsDeliveryDisable')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
