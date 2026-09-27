/**
 * Leaderboard + awards (ADR 0425 P4). The opt-in gate IS the disclosure:
 * joining shows exactly displayName + completion count to other members who
 * joined — nothing else, and leaving is immediate. Below the k-floor the
 * board shows only the caller (stated plainly, not silently).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StarIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { TextField } from '../../ui/Field.js';
import { formatDate } from '../../i18n/format.js';
import {
  getOptIn,
  joinLeaderboard,
  leaveLeaderboard,
  getLeaderboard,
  getAwards,
  type EngagementOptIn,
  type LeaderboardView,
  type KicktodoAward,
} from '../../client/kicktodoEngagementClient.js';
import { listEnrollments, listChallenges } from '../../client/kicktodoClient.js';
import { useAuth } from '../../auth/useAuth.js';
import { SignInButton } from '../../auth/SignInButton.js';

function awardKey(kind: string): string {
  switch (kind) {
    case 'first-check-in': return 'awardFirstCheckIn';
    case 'streak-7': return 'awardStreak7';
    case 'streak-30': return 'awardStreak30';
    case 'challenge-complete': return 'awardChallengeComplete';
    default: return 'awardComeback';
  }
}

export function EngagementPage() {
  const { t } = useTranslation('kicktodo-engagement');
  const { user, isConfigured } = useAuth();
  const anonymous = isConfigured && !user;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [optInRow, setOptInRow] = useState<EngagementOptIn | null>(null);
  const [board, setBoard] = useState<LeaderboardView | null>(null);
  const [awards, setAwards] = useState<KicktodoAward[]>([]);
  const [displayName, setDisplayName] = useState('');
  // ADR 0641 decision 13 — a board belongs to ONE challenge, so the page must
  // pick one. `challenges` is the caller's OWN enrolled set (never the catalog):
  // the route 404s for a challenge you are not in, so offering more would only
  // manufacture dead options.
  const [challenges, setChallenges] = useState<{ id: string; title: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(async (challengeId?: string) => {
    if (anonymous) return;
    try {
      setError(false);
      const [row, mine, enrollments, catalog] = await Promise.all([
        getOptIn(), getAwards(), listEnrollments(), listChallenges(),
      ]);
      setOptInRow(row);
      setAwards(mine);

      const titleById = new Map(catalog.map((c) => [c.id, c.title]));
      const mineChallenges = [...new Set(enrollments.map((e) => e.challengeId))]
        .map((id) => ({ id, title: titleById.get(id) ?? id }));
      setChallenges(mineChallenges);

      const pick = challengeId ?? selected ?? mineChallenges[0]?.id ?? null;
      setSelected(pick);
      // The board now loads WITHOUT requiring the opt-in: enrolment gates
      // looking, the opt-in gates appearing. An enrolled participant who has not
      // joined sees the board and simply is not on it.
      setBoard(pick ? await getLeaderboard(pick) : null);
    } catch {
      setError(true);
    } finally {
      setLoaded(true);
    }
  }, [anonymous, selected]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onJoin = async () => {
    if (!displayName.trim()) return;
    setBusy(true);
    try {
      await joinLeaderboard(displayName);
      await reload();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const onLeave = async () => {
    setBusy(true);
    try {
      await leaveLeaderboard();
      await reload();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" data-walkthrough="kicktodo-leaderboard.page">
      <header className="page-header">
        <h1 className="page-header__title">{t('title')}</h1>
        <p className="page-header__lede">{t('lede')}</p>
      </header>

      {anonymous ? (
        <StateCard
          icon={<StarIcon aria-hidden />}
          title={t('signedOutTitle')}
          body={t('signedOutBody')}
          action={
            <div>
              <p className="muted u-fs-13">{t('signedOutPrivacy')}</p>
              <SignInButton />
            </div>
          }
        />
      ) : null}

      {!anonymous && error && <Notice variant="error">{t('loadError')}</Notice>}
      {!anonymous && !loaded && !error && <StateCard loading title={t('title')} />}

      {/* Not a gate any more (ADR 0641 d13): the board renders above whether or
          not you have joined. This is the invitation to APPEAR on it. */}
      {!anonymous && loaded && !optInRow && !error && (
        <StateCard
          icon={<StarIcon aria-hidden />}
          title={t('joinTitle')}
          body={t('joinDisclosure')}
          action={
            <div className="action-bar">
              <TextField
                label={t('displayNameLabel')}
                value={displayName}
                maxLength={60}
                onChange={(e) => setDisplayName(e.target.value)}
              />
              <Button variant="primary" disabled={busy || !displayName.trim()} aria-busy={busy} onClick={() => void onJoin()}>
                {t('joinCta')}
              </Button>
            </div>
          }
        />
      )}

      {!anonymous && loaded && !error && challenges.length > 1 && (
        <div className="action-bar" role="group" aria-label={t('boardHeading')}>
          {challenges.map((c) => (
            <Button
              key={c.id}
              variant={c.id === selected ? 'primary' : 'quiet'}
              disabled={busy}
              onClick={() => { setSelected(c.id); void reload(c.id); }}
            >
              {c.title}
            </Button>
          ))}
        </div>
      )}

      {!anonymous && loaded && board && (
        <section className="surface-card" aria-label={t('boardHeading')}>
          <div className="action-bar">
            <h2>{t('boardHeading')}</h2>
            {optInRow && (
              <Button variant="quiet" disabled={busy} aria-busy={busy} onClick={() => void onLeave()}>
                {t('leaveCta')}
              </Button>
            )}
          </div>
          {board.belowFloor && <Notice variant="info">{t('belowFloor')}</Notice>}
          <ol role="list" className="list-plain">
            {board.entries.map((e) => (
              <li key={`${e.rank}-${e.displayName}`} className="list-row">
                <span className="chip">{t('rank', { rank: e.rank })}</span>
                <strong>{e.displayName}</strong>
                {e.you && <span className="chip chip--success">{t('youBadge')}</span>}
                <span className="muted">{t('completions', { count: e.completedCount })}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* KTUX-5: an opted-in member with no awards yet saw NOTHING here — the
          section simply vanished, which reads as a broken page rather than as
          "you have not earned one yet". State it. */}
      {/* Screen-polish: EARNED awards belong to the member regardless of the
          board opt-in — leaving the board must never hide what you hold. The
          empty state stays opt-in-scoped (it is board copy). */}
      {!anonymous && loaded && !error && (optInRow || awards.length > 0) && (
        <section className="surface-card" aria-label={t('awardsHeading')}>
          <h2>{t('awardsHeading')}</h2>
          {awards.length === 0 ? (
            <StateCard icon={<StarIcon aria-hidden />} title={t('noAwardsTitle')} body={t('noAwardsBody')} />
          ) : (
            <div className="action-bar">
              {awards.map((a) => (
                <span key={a.awardId + a.enrollmentId} className="chip chip--success"
                  title={formatDate(a.earnedAt, { dateStyle: 'medium' })}>
                  {t(awardKey(a.kind))}
                  <span className="muted u-fs-13"> · {formatDate(a.earnedAt, { dateStyle: 'medium' })}</span>
                </span>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
