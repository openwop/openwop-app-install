/**
 * Journal (ADR 0443 R5) — the participant's own record: every check-in note and
 * measurement across their challenges, newest first. Self-data only (the server
 * scopes to the caller); a read over existing check-ins — the original concept's
 * "journal as you go" honored without a new store. Reached from Progress.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { BookOpenIcon } from '../../ui/icons/index.js';
import { getJournal, listChallenges, type ChallengeSummary, type JournalEntry } from '../../client/kicktodoClient.js';
import { formatDate } from '../../i18n/format.js';

export function JournalPage(): JSX.Element {
  const { t } = useTranslation('kicktodo');
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [challenges, setChallenges] = useState<ChallengeSummary[]>([]);
  const [error, setError] = useState(false);

  const reload = () => {
    setError(false);
    void (async () => {
      try {
        const [es, cs] = await Promise.all([getJournal(), listChallenges().catch(() => [])]);
        setEntries(es); setChallenges(cs);
      } catch { setError(true); }
    })();
  };
  useEffect(reload, []);

  const challengeTitle = (id: string): string | null =>
    challenges.find((c) => c.id === id)?.title ?? null;

  // Group by calendar day (locale-formatted label as the key) — the reader's
  // own record reads as a diary, not a flat feed.
  const grouped = (entries ?? []).reduce<Array<{ day: string; items: JournalEntry[] }>>((acc, e) => {
    const day = (() => { try { return formatDate(e.createdAt, { dateStyle: 'full' }); } catch { return e.createdAt.slice(0, 10); } })();
    const last = acc[acc.length - 1];
    if (last && last.day === day) last.items.push(e);
    else acc.push({ day, items: [e] });
    return acc;
  }, []);

  const dateLabel = (iso: string): string => {
    try { return formatDate(iso, { dateStyle: 'medium' }); }
    catch { return iso.slice(0, 10); }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-header__title">{t('journalTitle')}</h1>
          <p className="page-header__lede">{t('journalLede')}</p>
        </div>
        <div className="page-header__actions">
          <Link className="btn-ghost btn-sm" to="/progress">{t('backToProgress')}</Link>
        </div>
      </header>

      {error && (
        <Notice variant="error">
          {t('journalError')}{' '}
          <Button variant="quiet" size="sm" onClick={reload}>{t('common:retry')}</Button>
        </Notice>
      )}
      {!entries && !error && <StateCard loading title={t('journalTitle')} />}
      {entries && entries.length === 0 && !error && (
        <StateCard icon={<BookOpenIcon aria-hidden />} title={t('journalEmptyTitle')} body={t('journalEmptyBody')} />
      )}

      {entries && entries.length > 0 && grouped.map((g) => (
        <section key={g.day} className="surface-card" aria-label={g.day}>
          <h2 className="kt-eyebrow">{g.day}</h2>
          <ul role="list" className="list-plain">
            {g.items.map((e) => (
              <li key={e.cardId} className="list-row">
                <div>
                  {/* The participant's OWN WORDS — the §4.2 serif human register. */}
                  {e.note && <p className="kt-journal-note">{e.note}</p>}
                  <div className="action-bar">
                    {challengeTitle(e.challengeId) && (
                      <span className="chip chip--muted">{challengeTitle(e.challengeId)}</span>
                    )}
                    {typeof e.measuredValue === 'number' && (
                      <span className="chip">{t('journalMeasured', { value: e.measuredValue })}</span>
                    )}
                    <span className="muted u-fs-13">{dateLabel(e.createdAt)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
