/**
 * Notification preferences subdrawer — opens inside the
 * `NotificationPanel` when the user clicks the gear icon.
 *
 * Sections:
 *   1. Global mute — kill switch for every notification toast + badge
 *   2. Per-type — table of known types with mute + desktop toggles
 *   3. Quiet hours — start/end time + days + allow-urgent toggle
 *
 * Persistence: every mutation calls `store.updatePreferences()` which
 * writes to localStorage immediately. No "Save" button — changes are
 * live as you toggle them, mirroring the rest of the chat surface's
 * inline-edit pattern.
 */

import { Button } from '../ui/Button.js';
import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
const EmailApprovalSection = lazy(() => import('./EmailApprovalSection.js').then((m) => ({ default: m.EmailApprovalSection })));
import { useNotificationStore } from './notificationStore.js';
import { KNOWN_TYPES, TYPE_LABEL_KEYS, type NotificationPreferences } from './types.js';
import { ArrowLeftIcon } from '../ui/icons/index.js';

/** Sunday-first day-of-week i18n keys (Date.prototype.getDay() index → key). */
const DAY_LABEL_KEYS = [
  'dayShortSun', 'dayShortMon', 'dayShortTue', 'dayShortWed', 'dayShortThu', 'dayShortFri', 'dayShortSat',
] as const;

export function NotificationPreferencesPanel(): JSX.Element {
  const { t } = useTranslation('notifications');
  const prefs = useNotificationStore((s) => s.preferences);
  const updatePreferences = useNotificationStore((s) => s.updatePreferences);
  const closePreferences = useNotificationStore((s) => s.closePreferences);

  const setGlobalMute = (globalMute: boolean): void =>
    updatePreferences({ ...prefs, globalMute });

  const setTypePref = (type: string, patch: { muted?: boolean; desktop?: boolean }): void => {
    const types = prefs.types.map((t) =>
      t.type === type
        ? {
            ...t,
            ...(patch.muted !== undefined ? { muted: patch.muted } : {}),
            ...(patch.desktop !== undefined ? { desktop: patch.desktop } : {}),
          }
        : t,
    );
    updatePreferences({ ...prefs, types });
  };

  // NOTIF-2 — stamp the browser IANA zone on any quiet-hours edit, so server-side
  // producers (channel-activity notifications) evaluate the window in the user's zone.
  const browserTz = (): string | undefined => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
  };
  const setQuietHours = (patch: Partial<NotificationPreferences['quietHours']>): void => {
    const tz = browserTz();
    updatePreferences({ ...prefs, quietHours: { ...prefs.quietHours, ...(tz ? { timezone: tz } : {}), ...patch } });
  };

  const toggleDay = (day: number): void => {
    const next = prefs.quietHours.days.includes(day)
      ? prefs.quietHours.days.filter((d) => d !== day)
      : [...prefs.quietHours.days, day].sort((a, b) => a - b);
    setQuietHours({ days: next });
  };

  return (
    <div className="u-flex-1 u-overflow-y-auto u-pad-3-4">
      <header className="u-flex u-items-center u-gap-2 u-mb-3">
        <Button
          variant="secondary" className="u-fs-12"
          onClick={closePreferences}
          aria-label={t('prefsBackLabel')}
        >
          <ArrowLeftIcon size={13} /> {t('prefsBack')}
        </Button>
        <h3 className="u-m-0 u-fs-14">{t('prefsHeading')}</h3>
      </header>

      {/* ADR 0478 §2 — email delivery of addressed approval requests (opt-in;
          lazy — the notification panel rides the entry chunk). */}
      <Suspense fallback={null}>
        <EmailApprovalSection />
      </Suspense>

      {/* Global mute */}
      <Section title={t('prefsSectionGlobal')}>
        <Row>
          <Label htmlFor="prefs-globalMute">{t('prefsMuteAll')}</Label>
          <input
            id="prefs-globalMute"
            type="checkbox"
            checked={prefs.globalMute}
            onChange={(e) => setGlobalMute(e.target.checked)}
          />
        </Row>
        <p className="muted u-fs-11 u-mbox-t1">
          {t('prefsGlobalHelp')}
        </p>
      </Section>

      {/* Per-type */}
      <Section title={t('prefsSectionTypes')}>
        <table className="notifprefs-table">
          <thead>
            <tr className="u-text-left">
              <th className="u-pad-4x0 u-fw-600">{t('prefsColType')}</th>
              <th className="notifprefs-th-mute">{t('prefsColMute')}</th>
              <th className="notifprefs-th-desktop">{t('prefsColDesktop')}</th>
            </tr>
          </thead>
          <tbody>
            {KNOWN_TYPES.map((type) => {
              const typePref = prefs.types.find((x) => x.type === type);
              const muted = typePref?.muted ?? false;
              const desktop = typePref?.desktop ?? true;
              const label = t(TYPE_LABEL_KEYS[type] ?? type);
              return (
                <tr key={type} className="u-border-t">
                  <td className="notifprefs-td-type">{label}</td>
                  <td className="u-text-center">
                    <input
                      type="checkbox"
                      checked={muted}
                      onChange={(e) => setTypePref(type, { muted: e.target.checked })}
                      aria-label={t('prefsMuteTypeLabel', { label })}
                    />
                  </td>
                  <td className="u-text-center">
                    <input
                      type="checkbox"
                      checked={desktop}
                      onChange={(e) => setTypePref(type, { desktop: e.target.checked })}
                      aria-label={t('prefsDesktopTypeLabel', { label })}
                      disabled={muted}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted u-fs-11 u-mbox-t2">
          <strong>{t('prefsTypesHelpMute')}</strong>{t('prefsTypesHelpMuteRest')}
          <strong>{t('prefsTypesHelpDesktop')}</strong>{t('prefsTypesHelpDesktopRest')}
        </p>
      </Section>

      {/* Quiet hours */}
      <Section title={t('prefsSectionQuietHours')}>
        <Row>
          <Label htmlFor="prefs-quiet-enabled">{t('prefsEnableQuietHours')}</Label>
          <input
            id="prefs-quiet-enabled"
            type="checkbox"
            checked={prefs.quietHours.enabled}
            onChange={(e) => setQuietHours({ enabled: e.target.checked })}
          />
        </Row>

        <div className={`notifprefs-quiet-times${prefs.quietHours.enabled ? '' : ' is-disabled'}`}>
          <label className="u-flex-1 u-flex u-flex-col u-gap-1 u-fs-11">
            {t('prefsQuietStart')}
            <input
              type="time"
              value={prefs.quietHours.start}
              onChange={(e) => setQuietHours({ start: e.target.value })}
              disabled={!prefs.quietHours.enabled}
              className="u-fs-13"
            />
          </label>
          <label className="u-flex-1 u-flex u-flex-col u-gap-1 u-fs-11">
            {t('prefsQuietEnd')}
            <input
              type="time"
              value={prefs.quietHours.end}
              onChange={(e) => setQuietHours({ end: e.target.value })}
              disabled={!prefs.quietHours.enabled}
              className="u-fs-13"
            />
          </label>
        </div>

        {/* SCHEDUX-1 — surface WHICH timezone the window is evaluated in (the value
            server-side producers honor), so a user whose device tz differs isn't guessing. */}
        {prefs.quietHours.enabled && (prefs.quietHours.timezone ?? browserTz()) && (
          <p className="muted u-fs-10 u-mt-1 u-mb-0">{t('prefsQuietTz', { tz: prefs.quietHours.timezone ?? browserTz() })}</p>
        )}

        <div className="u-mt-2">
          <div className="muted u-fs-11 u-mb-1">{t('prefsQuietDays')}</div>
          <div className="u-flex u-gap-1 u-wrap">
            {DAY_LABEL_KEYS.map((labelKey, day) => {
              const active = prefs.quietHours.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  disabled={!prefs.quietHours.enabled}
                  aria-pressed={active}
                  className="notifprefs-day"
                >
                  {t(labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        <Row className={`u-mt-2 notifprefs-urgent-row${prefs.quietHours.enabled ? '' : ' is-disabled'}`}>
          <Label htmlFor="prefs-quiet-allowUrgent">{t('prefsAllowUrgent')}</Label>
          <input
            id="prefs-quiet-allowUrgent"
            type="checkbox"
            checked={prefs.quietHours.allowUrgent}
            onChange={(e) => setQuietHours({ allowUrgent: e.target.checked })}
            disabled={!prefs.quietHours.enabled}
          />
        </Row>
        <p className="muted u-fs-11 u-mbox-t1">
          {t('prefsQuietHelpStart')}
          <code>{t('prefsQuietHelpUrgentToken')}</code>
          {t('prefsQuietHelpEnd')}
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="notifprefs-section">
      <h4 className="notifprefs-section-title">
        {title}
      </h4>
      {children}
    </section>
  );
}

function Row({ children, style, className }: { children: React.ReactNode; style?: React.CSSProperties; className?: string }): JSX.Element {
  return (
    <div className={`u-flex u-items-center u-gap-2${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  );
}

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }): JSX.Element {
  return (
    <label htmlFor={htmlFor} className="u-flex-1 u-fs-13 u-cursor-pointer">
      {children}
    </label>
  );
}
