/**
 * Get started tile (ADR 0844) — a setup checklist in place of a wall of empty
 * tiles. The old default dashboard greeted a new workspace with six cards that
 * each said "nothing yet"; this says what to do first, and ticks steps off from
 * real state.
 *
 * Steps are filtered to what the caller can actually do: connecting an app and
 * adding a model key live on the admin-tier Access page, so a member (and the
 * anonymous demo visitor, who is not an admin) never sees a step that leads to
 * "Administrator access required". A step whose read FAILS shows as not done
 * with no claim either way — the list never marks something complete it could
 * not check.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listStoredRefs } from '../../../byok/lib/byokClient.js';
import { useEffectiveAccessState, isAdminCaller } from '../../../client/useEffectiveAccess.js';
import { useAuth } from '../../../auth/useAuth.js';
import { SignInButton } from '../../../auth/SignInButton.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { CheckIcon } from '../../../ui/icons/index.js';
import { readChatSessions, readConnections } from '../sharedReads.js';
import { readMyRuns } from '../runsWindow.js';
import type { DashboardTileProps } from '../tileTypes.js';

type StepId = 'chat' | 'run' | 'connect' | 'key' | 'signin';

interface Step {
  id: StepId;
  /** true = done, false = not done, null = could not check. */
  done: boolean | null;
  to?: string;
  /** Shown, but not required for the checklist to count as complete. */
  optional?: boolean;
}

const count = (p: Promise<readonly unknown[]>): Promise<boolean | null> =>
  p.then((xs) => xs.length > 0, () => null);

export default function GetStartedTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const isAdmin = isAdminCaller(useEffectiveAccessState().access);
  const { user, loading: authLoading } = useAuth();
  const anonymous = !authLoading && user === null;
  const [steps, setSteps] = useState<Step[] | null>(null);

  useEffect(() => {
    let live = true;
    const checks: Array<Promise<Step>> = [
      count(readChatSessions()).then((done) => ({ id: 'chat' as const, done, to: '/chat' })),
      // The caller's OWN runs (issue 4511): "Run a workflow" is ticked by running one,
      // not by a colleague having run one.
      count(readMyRuns()).then((done) => ({ id: 'run' as const, done, to: '/builder' })),
    ];
    if (isAdmin) {
      checks.push(count(readConnections()).then((done) => ({ id: 'connect' as const, done, to: '/access?tab=connections' })));
      checks.push(count(listStoredRefs()).then((done) => ({ id: 'key' as const, done, to: '/access?tab=keys', optional: true })));
    }
    void Promise.all(checks).then((s) => { if (live) setSteps(s); });
    return () => { live = false; };
  }, [isAdmin]);

  if (steps === null || authLoading) return <SkeletonRows rows={3} columns={['8%', '62%', '20%']} />;

  const all: Step[] = anonymous ? [...steps, { id: 'signin', done: false }] : steps;
  const doneCount = all.filter((s) => s.done === true).length;
  // The optional model-key step never holds the checklist open: a workspace on
  // the included model is fully set up without it.
  const required = all.filter((s) => !s.optional);

  if (required.every((s) => s.done === true)) {
    return <p className="dash-needs__clear"><CheckIcon size={16} aria-hidden /> {t('startDone')}</p>;
  }

  return (
    <div className="dash-start">
      <div className="dash-start__progress">
        <span className="muted">{t('startProgress', { done: doneCount, total: all.length })}</span>
        <progress className="dash-start__bar" max={all.length} value={doneCount} aria-label={t('startProgressLabel')} />
      </div>
      <ol className="dash-start__steps u-list-none u-m-0 u-p-0">
        {all.map((s) => (
          <li key={s.id} className={`dash-start__step${s.done ? ' is-done' : ''}`}>
            <span className="dash-start__check" aria-hidden>{s.done ? <CheckIcon size={14} /> : null}</span>
            <span className="dash-start__text">
              <span className="dash-start__title">
                {t(`start_${s.id}`)}
                <span className="sr-only"> — {t(s.done ? 'startStateDone' : 'startStateTodo')}</span>
              </span>
              <span className="dash-start__detail muted">{t(`start_${s.id}Detail`)}</span>
            </span>
            {!s.done ? (
              s.id === 'signin'
                ? <SignInButton />
                : <Link to={s.to ?? '/'} className="btn secondary btn-sm">{t(`start_${s.id}Cta`)}</Link>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
