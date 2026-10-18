/**
 * Where a daypart reminder actually goes (ADR 0443 R1 / ADR 0421).
 *
 * A reminder leaves the app only when two things are true: the participant has
 * granted the `messaging-reminders` consent (`routeReminder` refuses without it)
 * and this browser holds a push subscription. Until this component existed the
 * Today page told participants to allow messaging reminders "in your integration
 * consents", a screen that does not exist, so no participant could ever receive
 * a reminder outside the app. It states what is true and offers the one gesture
 * that makes it true; it never claims delivery it cannot back.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { getConsents, grantConsent, revokeConsent } from '../../client/kicktodoIntegrationsClient.js';
import { useNotificationStore } from '../../notifications/notificationStore.js';

export const REMINDER_CONSENT = 'messaging-reminders';

export function ReminderDelivery(): JSX.Element | null {
  const { t } = useTranslation('kicktodo');
  const pushStatus = useNotificationStore((s) => s.pushStatus);
  const syncPushStatus = useNotificationStore((s) => s.syncPushStatus);
  const enablePush = useNotificationStore((s) => s.enablePush);
  // null = not read yet; 'failed' = the consent read failed (stated, never hidden).
  const [consented, setConsented] = useState<boolean | null | 'failed'>(null);
  // PT-3 — WHICH action is in flight, so only its button reports aria-busy.
  const [busy, setBusy] = useState<null | 'allow' | 'device' | 'stop'>(null);
  const [actionFailed, setActionFailed] = useState(false);

  const read = useCallback(async () => {
    try {
      const cs = await getConsents();
      setConsented(cs.some((c) => c.kind === REMINDER_CONSENT && !c.revokedAt));
    } catch {
      setConsented('failed');
    }
  }, []);
  useEffect(() => { void read(); void syncPushStatus(); }, [read, syncPushStatus]);

  const onAllow = async () => {
    setBusy('allow');
    setActionFailed(false);
    try {
      // Subscribe FIRST: `pushManager.subscribe()` must run inside the click's
      // user activation, which an awaited network call before it can spend.
      // ADR 0816 NTFUX-2 — a refused subscribe is a failure, not a consent: the
      // reminders this consent promises would never reach the device.
      if (pushStatus === 'available' && !(await enablePush())) { setActionFailed(true); return; }
      await grantConsent(REMINDER_CONSENT);
      await read();
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(null);
    }
  };
  const onDeviceOnly = async () => {
    setBusy('device');
    setActionFailed(false);
    // PT-3 — a THROWN subscribe (not just a refused one) is a stated failure,
    // never an unhandled rejection.
    try { if (!(await enablePush())) setActionFailed(true); }
    catch { setActionFailed(true); }
    finally { setBusy(null); }
  };
  const onStop = async () => {
    setBusy('stop');
    setActionFailed(false);
    try { await revokeConsent(REMINDER_CONSENT); await read(); }
    catch { setActionFailed(true); }
    finally { setBusy(null); }
  };

  // PT-3 — the read in flight is SAID, not rendered as nothing.
  if (consented === null) {
    return <p className="muted u-fs-13" aria-busy="true">{t('reminderDelivery_checking')}</p>;
  }
  const onDevice = pushStatus === 'subscribed';
  const canSubscribe = pushStatus === 'available';

  return (
    <>
      {consented === 'failed' ? (
        <p className="muted u-fs-13">
          <span className="chip chip--muted">{t('reminderDelivery_unavailable')}</span>{' '}
          <Button variant="quiet" size="sm" onClick={() => { setConsented(null); void read(); }}>{t('common:retry')}</Button>
        </p>
      ) : consented ? (
        <p className="muted u-fs-13">
          <span className={onDevice ? 'chip chip--success' : 'chip'}>
            {onDevice ? t('reminderDelivery_onDevice') : t('reminderDelivery_inboxOnly')}
          </span>{' '}
          {!onDevice && canSubscribe && (
            <Button variant="quiet" size="sm" disabled={busy !== null} loading={busy === 'device'} onClick={() => void onDeviceOnly()}>
              {t('reminderDelivery_addDevice')}
            </Button>
          )}
          <Button variant="quiet" size="sm" disabled={busy !== null} loading={busy === 'stop'} onClick={() => void onStop()}>
            {t('reminderDelivery_stop')}
          </Button>
        </p>
      ) : (
        <p className="muted u-fs-13">
          {t('reminderDelivery_off')}{' '}
          <Button variant="secondary" size="sm" disabled={busy !== null} loading={busy === 'allow'} onClick={() => void onAllow()}>
            {t('reminderDelivery_allow')}
          </Button>
        </p>
      )}
      {actionFailed && (
        <Notice variant="error" announce={t('reminderDelivery_actionError')}>{t('reminderDelivery_actionError')}</Notice>
      )}
    </>
  );
}
