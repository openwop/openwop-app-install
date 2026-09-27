/**
 * ADR 0202 D3 — the channel "Schedule a recurring post" surface, an owner-only
 * subsection of the channel details dialog (which is lazy-loaded, so this stays
 * off the entry bundle). Composes the EXISTING scheduler via the channel-scoped
 * scheduled-chats routes — no second scheduling system.
 *
 * The agent picker offers only CHANNEL-MEMBER agents (the backend requires it —
 * M3). Cadence is composed from friendly controls (frequency + a native time
 * picker + a weekday when weekly — ADR 0202 OQ-4), never a raw cron field; the
 * browser timezone is sent so the time is the owner's local, DST-correct.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listChannelScheduledPosts, createChannelScheduledPost, setChannelScheduledPostEnabled, deleteChannelScheduledPost,
  type ChannelScheduledPost,
} from '../../client/channelsClient.js';
import { formatDateTime, formatTime, formatWeekday } from '../../i18n/format.js';

/** A channel-member agent, from the resolved roster. */
export interface ScheduleAgent { agentId: string; displayName: string }

interface Props {
  channelId: string;
  /** Channel-member agents — the only agents a schedule may bind (M3). */
  agents: ScheduleAgent[];
}

type Frequency = 'daily' | 'weekdays' | 'weekly' | 'hourly';
const FREQUENCIES: Frequency[] = ['daily', 'weekdays', 'weekly', 'hourly'];

const browserTz = (): string | undefined => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
};

/** Compose a 5-field cron from the picker state. `time` is a native "HH:MM" (24h). */
function composeCron(freq: Frequency, time: string, dow: number): string {
  const [hh, mm] = time.split(':');
  const h = String(Math.min(23, Math.max(0, parseInt(hh ?? '0', 10) || 0)));
  const m = String(Math.min(59, Math.max(0, parseInt(mm ?? '0', 10) || 0)));
  switch (freq) {
    case 'hourly': return '0 * * * *';           // every hour on the hour
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly': return `${m} ${h} * * ${dow}`;
    case 'daily':
    default: return `${m} ${h} * * *`;
  }
}

export function ChannelSchedulePanel({ channelId, agents }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const { t: tc } = useTranslation('common');
  const [posts, setPosts] = useState<ChannelScheduledPost[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('daily');
  const [time, setTime] = useState('09:00');
  const [dow, setDow] = useState(1); // Monday
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justScheduled, setJustScheduled] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  // SCHEDUX-2 — move focus onto the Confirm button when the inline delete-confirm opens,
  // so a keyboard user doesn't have to tab to reach the destructive action.
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmingDeleteId) confirmRef.current?.focus(); }, [confirmingDeleteId]);

  const reload = useCallback(async (): Promise<void> => {
    setLoadFailed(false);
    try { setPosts(await listChannelScheduledPosts(channelId)); }
    catch { setLoadFailed(true); }
  }, [channelId]);

  useEffect(() => { void reload(); }, [reload]);

  // Humanize a stored cron for the list. Handles every shape the picker composes
  // (and the legacy fixed presets); an unrecognized cron shows verbatim.
  const cadenceLabel = useCallback((cron: string): string => {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;
    const [m, h, dom, mon, dw] = parts as [string, string, string, string, string];
    if (dom !== '*' || mon !== '*') return cron;
    if (h === '*') return m === '0' ? t('schedLabelHourly') : cron; // only the on-the-hour shape the picker emits
    const mi = Number(m), hi = Number(h);
    if (!Number.isInteger(mi) || mi < 0 || mi > 59 || !Number.isInteger(hi) || hi < 0 || hi > 23) return cron;
    const clock = formatTime(new Date(2000, 0, 1, hi, mi));
    if (dw === '*') return t('schedLabelDaily', { time: clock });
    if (dw === '1-5') return t('schedLabelWeekdays', { time: clock });
    if (/^[0-7]$/.test(dw)) return t('schedLabelWeekly', { day: formatWeekday(Number(dw) % 7), time: clock });
    return cron;
  }, [t]);

  const run = useCallback(async (op: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try { await op(); await reload(); }
    catch { setError(t('schedError')); }
    finally { setBusy(false); }
  }, [reload, t]);

  const onCreate = (): void => {
    const p = prompt.trim();
    if (!agentId || !p) return;
    const cron = composeCron(frequency, time, dow);
    const tz = browserTz();
    setJustScheduled(false);
    void run(async () => {
      await createChannelScheduledPost(channelId, { agentId, prompt: p, cronExpr: cron, ...(tz ? { timezone: tz } : {}) });
      setPrompt('');
      setJustScheduled(true);
    });
  };

  const fmt = (iso?: string): string => (iso ? formatDateTime(iso) : '—');
  const knownAgent = (id: string): ScheduleAgent | undefined => agents.find((a) => a.agentId === id);
  const tz = browserTz();

  return (
    <section className="chansched" aria-label={t('schedPostsTitle')}>
      <h3 className="u-fs-13 u-mb-1">{t('schedPostsTitle')}</h3>
      <p className="muted u-fs-11 u-mt-0 u-mb-2">{t('schedPostsHint')}</p>

      {loadFailed && (
        <div className="u-flex u-items-center u-gap-2 u-mb-2">
          <span className="alert error u-fs-11" role="alert">{t('schedLoadError')}</span>
          <Button variant="secondary" size="sm" onClick={() => void reload()}>{tc('retry')}</Button>
        </div>
      )}

      {posts && posts.length > 0 && (
        <ul className="u-list-none u-m-0 u-p-0 u-mb-2">
          {posts.map((s) => {
            const known = knownAgent(s.agentId);
            return (
              <li key={s.chatId} className="u-flex u-items-center u-justify-between u-gap-2 u-fs-12 u-pad-1-2">
                <span className="u-flex u-flex-col u-gap-0-5 u-min-w-0">
                  <span className="u-truncate"><strong>{known?.displayName ?? s.agentId}</strong> · {cadenceLabel(s.cronExpr)}</span>
                  <span className="muted u-truncate u-fs-11">{s.prompt}</span>
                  <span className="muted u-fs-10">
                    {!known ? t('schedAgentRemoved') : s.enabled ? t('schedNextRun', { when: fmt(s.nextRunAt) }) : t('schedPaused')}
                  </span>
                </span>
                {confirmingDeleteId === s.chatId ? (
                  <span className="u-flex u-items-center u-gap-1">
                    <span className="muted u-fs-11">{t('schedConfirmDelete')}</span>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmingDeleteId(null)}>{tc('cancel')}</Button>
                    <Button ref={confirmRef} variant="primary" size="sm" disabled={busy} onClick={() => void run(async () => { await deleteChannelScheduledPost(channelId, s.chatId); setConfirmingDeleteId(null); })}>{tc('remove')}</Button>
                  </span>
                ) : (
                  <span className="u-flex u-items-center u-gap-1">
                    {known && (
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => setChannelScheduledPostEnabled(channelId, s.chatId, !s.enabled))}>
                        {s.enabled ? t('schedPauseCta') : t('schedResumeCta')}
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmingDeleteId(s.chatId)} aria-label={t('schedDeleteAria')}>
                      {tc('remove')}
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {posts && posts.length === 0 && !loadFailed && <p className="muted u-fs-12 u-mb-2">{t('schedPostsEmpty')}</p>}

      {agents.length === 0 ? (
        <p className="muted u-fs-12">{t('schedNoAgents')}</p>
      ) : (
        <div className="chansched-form u-flex u-flex-col u-gap-1">
          <label className="field">
            <span className="field-label">{t('schedAgentLabel')}</span>
            <select value={agentId} onChange={(e) => { setAgentId(e.target.value); setJustScheduled(false); }} disabled={busy}>
              <option value="">{t('schedAgentPlaceholder')}</option>
              {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.displayName}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('schedPromptLabel')}</span>
            <textarea value={prompt} onChange={(e) => { setPrompt(e.target.value); setJustScheduled(false); }} placeholder={t('schedPromptPlaceholder')} rows={2} maxLength={2000} disabled={busy} />
          </label>
          <div className="u-flex u-flex-wrap u-gap-2">
            <label className="field chansched-cad">
              <span className="field-label">{t('schedCadenceLabel')}</span>
              <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} disabled={busy}>
                {FREQUENCIES.map((f) => <option key={f} value={f}>{t(`schedFreq_${f}`)}</option>)}
              </select>
            </label>
            {frequency === 'weekly' && (
              <label className="field chansched-cad">
                <span className="field-label">{t('schedDayLabel')}</span>
                <select value={dow} onChange={(e) => setDow(Number(e.target.value))} disabled={busy}>
                  {[0, 1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{formatWeekday(d)}</option>)}
                </select>
              </label>
            )}
            {frequency !== 'hourly' && (
              <label className="field chansched-cad">
                <span className="field-label">{t('schedTimeLabel')}</span>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={busy} />
              </label>
            )}
          </div>
          {tz && frequency !== 'hourly' && <p className="muted u-fs-10 u-mt-0 u-mb-0">{t('schedTzHint', { tz })}</p>}
          <div className="u-flex u-items-center u-justify-between u-gap-2">
            <span className="u-fs-11" role="status">{justScheduled ? t('schedScheduled') : ''}</span>
            <Button variant="secondary" size="sm" disabled={busy || !agentId || !prompt.trim()} onClick={onCreate}>{t('schedCreateCta')}</Button>
          </div>
        </div>
      )}
      {error && <p className="alert error u-fs-11 u-mt-1" role="alert">{error}</p>}
    </section>
  );
}
