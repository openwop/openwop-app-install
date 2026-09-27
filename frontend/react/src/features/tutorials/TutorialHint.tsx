/**
 * ADR 0488 D7 — contextual placement: "Teach me this".
 *
 * A tutorials INDEX is where tutorials go to be ignored. The completion evidence
 * is blunt about it — guidance works when it arrives inside the workflow the
 * learner is already in, and user-TRIGGERED guidance outperforms auto-triggered
 * by 2–4×. So a tutorial declares the routes it teaches (`surfaces`), and this
 * renders one quiet affordance on those screens.
 *
 * Three rules it will not break:
 *  - **Never auto-launches.** ADR 0488 D5 makes that an invariant, not a taste:
 *    ~70% of learners skip guidance that seizes the wheel. This offers; it never
 *    takes over. It links to the tutorial — it does not start a walkthrough.
 *  - **Dismissible, and it stays dismissed.** A hint the learner has waved off
 *    is noise on every subsequent visit, so dismissal persists per tutorial.
 *  - **Never on `/tutorials` itself**, where it would be circular.
 *
 * It is deliberately a low-emphasis inline affordance rather than a toast,
 * banner or modal: it must be ignorable at a glance by someone who knows the
 * screen, and findable by someone who does not.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TUTORIALS } from './registry.js';
import { fetchTutorialProgress } from './tutorialsClient.js';

const DISMISS_KEY = 'openwop-app.tutorials.hintsDismissed';

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

/**
 * Does this tutorial teach the current route? Exact match, or the route is a
 * child of a declared surface (`/funnels` teaches `/funnels/abc`). Deliberately
 * NOT a prefix match on raw strings — that would make `/commerce` claim
 * `/commerce-connect`, a different feature entirely.
 */
function teachesRoute(surfaces: readonly string[] | undefined, pathname: string): boolean {
  return (surfaces ?? []).some((s) => pathname === s || pathname.startsWith(`${s}/`));
}

export function TutorialHint(): JSX.Element | null {
  const { t } = useTranslation('tutorials');
  const { pathname } = useLocation();
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  /**
   * ADR 0488 D7 — tutorials this learner has already FINISHED.
   *
   * Found by the whole-program grade pass: D7 shipped without consulting D4's
   * progress, so the hint kept offering "Teach me this" on a screen whose
   * tutorial the learner had already completed. Harmless once; nagging forever,
   * and it makes the affordance read as untargeted noise rather than help.
   *
   * Best-effort by design — a failed read simply leaves the hint offering, which
   * is the safe direction (an unhelpful offer beats hiding a tutorial someone
   * needs). Anonymous readers have no server progress and keep seeing it.
   */
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    void fetchTutorialProgress().then((res) => {
      if (cancelled || !res.ok || !res.persisted) return;
      const done = new Set<string>();
      for (const row of res.rows) {
        const tut = TUTORIALS.find((t) => t.id === row.tutorialId);
        if (!tut) continue;
        const total = tut.phases.reduce((n, ph) => n + ph.steps.length, 0);
        if (total > 0 && row.completedStepIds.length >= total) done.add(row.tutorialId);
      }
      setCompleted(done);
    });
    return () => { cancelled = true; };
  }, []);

  const match = useMemo(() => {
    if (pathname === '/tutorials' || pathname.startsWith('/tutorials/')) return null;
    return TUTORIALS.find((tut) =>
      teachesRoute(tut.surfaces, pathname)
      && !dismissed.includes(tut.id)
      && !completed.has(tut.id)) ?? null;
  }, [pathname, dismissed, completed]);

  if (!match) return null;

  const dismiss = (): void => {
    const next = [...dismissed, match.id];
    setDismissed(next);
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };

  return (
    <aside className="tutorial-hint" role="complementary" aria-label={t('hintRegionLabel')}>
      <span className="tutorial-hint__text">{t('hintLede', { title: match.title })}</span>
      <Link className="btn-link" to={`/tutorials/${encodeURIComponent(match.id)}`}>{t('hintCta')}</Link>
      <Button variant="quiet" size="sm" onClick={dismiss}>{t('hintDismiss')}</Button>
    </aside>
  );
}
