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

import { useNotificationStore } from './notificationStore.js';
import { KNOWN_TYPES, TYPE_LABELS, type NotificationPreferences } from './types.js';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function NotificationPreferencesPanel(): JSX.Element {
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

  const setQuietHours = (patch: Partial<NotificationPreferences['quietHours']>): void =>
    updatePreferences({ ...prefs, quietHours: { ...prefs.quietHours, ...patch } });

  const toggleDay = (day: number): void => {
    const next = prefs.quietHours.days.includes(day)
      ? prefs.quietHours.days.filter((d) => d !== day)
      : [...prefs.quietHours.days, day].sort((a, b) => a - b);
    setQuietHours({ days: next });
  };

  return (
    <div className="u-flex-1 u-overflow-y-auto u-pad-3-4">
      <header className="u-flex u-items-center u-gap-2 u-mb-3">
        <button
          type="button"
          className="secondary u-fs-12"
          onClick={closePreferences}
          aria-label="Back to notifications"
        >
          ← Back
        </button>
        <h3 className="u-m-0 u-fs-14">Preferences</h3>
      </header>

      {/* Global mute */}
      <Section title="Global">
        <Row>
          <Label htmlFor="prefs-globalMute">Mute all notifications</Label>
          <input
            id="prefs-globalMute"
            type="checkbox"
            checked={prefs.globalMute}
            onChange={(e) => setGlobalMute(e.target.checked)}
          />
        </Row>
        <p className="muted u-fs-11 u-mbox-t1">
          Suppresses the bell badge + every desktop toast. Notifications still
          arrive and appear in the panel so you can clear them later.
        </p>
      </Section>

      {/* Per-type */}
      <Section title="Types">
        <table className="notifprefs-table">
          <thead>
            <tr className="u-text-left">
              <th className="u-pad-4x0 u-fw-600">Type</th>
              <th className="notifprefs-th-mute">Mute</th>
              <th className="notifprefs-th-desktop">Desktop</th>
            </tr>
          </thead>
          <tbody>
            {KNOWN_TYPES.map((type) => {
              const t = prefs.types.find((x) => x.type === type);
              const muted = t?.muted ?? false;
              const desktop = t?.desktop ?? true;
              return (
                <tr key={type} className="u-border-t">
                  <td className="notifprefs-td-type">{TYPE_LABELS[type] ?? type}</td>
                  <td className="u-text-center">
                    <input
                      type="checkbox"
                      checked={muted}
                      onChange={(e) => setTypePref(type, { muted: e.target.checked })}
                      aria-label={`Mute ${TYPE_LABELS[type] ?? type}`}
                    />
                  </td>
                  <td className="u-text-center">
                    <input
                      type="checkbox"
                      checked={desktop}
                      onChange={(e) => setTypePref(type, { desktop: e.target.checked })}
                      aria-label={`Desktop toast for ${TYPE_LABELS[type] ?? type}`}
                      disabled={muted}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted u-fs-11 u-mbox-t2">
          <strong>Mute</strong> hides the row from the badge count (still appears in the panel).{' '}
          <strong>Desktop</strong> controls the OS-level toast (no effect when mute is on or
          permission isn't granted).
        </p>
      </Section>

      {/* Quiet hours */}
      <Section title="Quiet hours">
        <Row>
          <Label htmlFor="prefs-quiet-enabled">Enable quiet hours</Label>
          <input
            id="prefs-quiet-enabled"
            type="checkbox"
            checked={prefs.quietHours.enabled}
            onChange={(e) => setQuietHours({ enabled: e.target.checked })}
          />
        </Row>

        <div className="notifprefs-quiet-times" style={{ opacity: prefs.quietHours.enabled ? 1 : 0.4 }}>
          <label className="u-flex-1 u-flex u-flex-col u-gap-1 u-fs-11">
            Start
            <input
              type="time"
              value={prefs.quietHours.start}
              onChange={(e) => setQuietHours({ start: e.target.value })}
              disabled={!prefs.quietHours.enabled}
              className="u-fs-13"
            />
          </label>
          <label className="u-flex-1 u-flex u-flex-col u-gap-1 u-fs-11">
            End
            <input
              type="time"
              value={prefs.quietHours.end}
              onChange={(e) => setQuietHours({ end: e.target.value })}
              disabled={!prefs.quietHours.enabled}
              className="u-fs-13"
            />
          </label>
        </div>

        <div className="u-mt-2">
          <div className="muted u-fs-11 u-mb-1">Days</div>
          <div className="u-flex u-gap-1 u-wrap">
            {DAY_LABELS.map((label, day) => {
              const active = prefs.quietHours.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  disabled={!prefs.quietHours.enabled}
                  aria-pressed={active}
                  className="notifprefs-day"
                  style={{
                    border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    background: active ? 'color-mix(in oklch, var(--color-accent) 12%, transparent)' : 'transparent',
                    color: active ? 'var(--color-accent)' : 'var(--color-text)',
                    cursor: prefs.quietHours.enabled ? 'pointer' : 'not-allowed',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <Row style={{ marginTop: 8, opacity: prefs.quietHours.enabled ? 1 : 0.4 }}>
          <Label htmlFor="prefs-quiet-allowUrgent">Allow urgent during quiet hours</Label>
          <input
            id="prefs-quiet-allowUrgent"
            type="checkbox"
            checked={prefs.quietHours.allowUrgent}
            onChange={(e) => setQuietHours({ allowUrgent: e.target.checked })}
            disabled={!prefs.quietHours.enabled}
          />
        </Row>
        <p className="muted u-fs-11 u-mbox-t1">
          Crosses midnight when end &lt; start (e.g., 22:00 → 08:00). During the window,
          desktop toasts are suppressed unless the row's priority is <code>urgent</code> and
          this toggle is on.
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

function Row({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...style }}>
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
