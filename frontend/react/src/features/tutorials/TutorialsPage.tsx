/**
 * Tutorials (ADR 0490) — the MyndHyve tutorial system on this app's design
 * system: a card list of walkthroughs + a data-driven renderer (hero, phases,
 * steps, discriminated content blocks) with per-step progress persisted in
 * localStorage. Content is authored data (`content/`), never JSX — one
 * renderer, many tutorials.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { requestWalkthroughLaunch } from '../../walkthroughs/walkthroughBus.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { CheckIcon, CheckSquareIcon } from '../../ui/icons/index.js';
import { TUTORIALS, getTutorial } from './registry.js';
import { fetchTutorial, fetchTutorials, fetchTutorialProgress, saveTutorialProgress } from './tutorialsClient.js';
import type { TutorialData, TutorialStepContent } from './tutorialTypes.js';

const storageKey = (tutorialId: string): string => `openwop-app.tutorials.${tutorialId}`;

/** Where the learner's progress actually lives, so the UI can say so honestly. */
// 'checking' is the pre-resolution arm (grade-ux `I2`): the state used to start
// at 'local', so a signed-in learner whose progress IS server-backed saw "Saved on
// this device" painted for the length of the round-trip — a false statement that a
// screen reader could read aloud before it flipped. 'checking' renders no chip.
type ProgressMode = 'checking' | 'server' | 'local' | 'unavailable';

/**
 * ADR 0488 D4 — progress is server-backed for a signed-in learner, with
 * `localStorage` as the floor.
 *
 * The local copy is written FIRST and always: it is what makes the checkbox
 * instant, what covers anonymous readers, and what survives an offline session.
 * The server write follows and is allowed to fail — but a failure DOWNGRADES the
 * mode rather than being swallowed, so the surface can tell the learner their
 * progress is only on this device instead of implying it is saved everywhere.
 *
 * Server rows win on load (cross-device is the whole point), but only when the
 * read genuinely succeeded — a FAILED read falls back to local and reports
 * `unavailable`. Rendering a failed read as "no progress" would look to the
 * learner exactly like their work being deleted.
 */
function useTutorialProgress(tutorialId: string): {
  done: Set<string>;
  toggle: (stepId: string) => void;
  reset: () => void;
  mode: ProgressMode;
} {
  const [done, setDone] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey(tutorialId));
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
  const [mode, setMode] = useState<ProgressMode>('checking');
  // Only the FIRST load may overwrite local state from the server; later
  // re-renders must not clobber a toggle the learner just made.
  /**
   * Guards the async persist continuation below. `saveTutorialProgress(...)` is
   * fire-and-forget, so its `.then` can land after the page has unmounted and
   * call `setMode`/`setDone` on a dead component. Under jsdom that is not merely
   * a warning: React's `getCurrentEventPriority` touches `window`, which the
   * torn-down test environment no longer has, so it surfaces as
   * `ReferenceError: window is not defined` — an UNHANDLED REJECTION that fails
   * the whole suite while every test still reports green. That is exactly how it
   * reached `main`: 3782 passed, `Errors 1`, exit 1.
   *
   * Re-armed INSIDE the effect, never cleanup-only. StrictMode mounts → cleans
   * up → remounts, so a ref that is only ever set false in cleanup is already
   * false by the time the component is really live and the guard silently
   * disables the code it protects (the ADR 0517 Phase E trap — that guard
   * shipped DEAD for precisely this reason). Same shape as `memory/MemoryBrowser`.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const hydrated = useRef(false);
  /** The value last known to be on the server, so we never echo it back. */
  const lastPersisted = useRef<string | null>(null);

  useEffect(() => {
    hydrated.current = false;
    lastPersisted.current = null;
    let cancelled = false;
    void fetchTutorialProgress().then((res) => {
      if (cancelled) return;
      hydrated.current = true;
      if (!res.ok) { setMode('unavailable'); return; }
      if (!res.persisted) { setMode('local'); return; }
      setMode('server');
      const row = res.rows.find((r) => r.tutorialId === tutorialId);
      // Seed the echo guard with what the server already holds (including the
      // empty case) so the first render never re-sends it.
      lastPersisted.current = JSON.stringify([...(row?.completedStepIds ?? [])].sort());
      if (row) setDone(new Set(row.completedStepIds));
    });
    return () => { cancelled = true; };
  }, [tutorialId]);

  useEffect(() => {
    try { localStorage.setItem(storageKey(tutorialId), JSON.stringify([...done])); } catch { /* private mode — progress is best-effort */ }
  }, [tutorialId, done]);

  /** Set by `reset()` so the NEXT persist is sent as an explicit clear — the one
   *  write the server must not union with a concurrent device (`TUT-7`). */
  const clearing = useRef(false);

  /** Persist to the server, but never before the initial hydrate — otherwise the
   *  empty pre-load state would overwrite the learner's real server row — and
   *  never re-send an unchanged value. Without that second guard, hydrating a
   *  tutorial that HAS server progress immediately POSTs the value it just
   *  loaded, and does it again when `mode` flips (which changes this callback's
   *  identity and re-fires the effect). That is two redundant writes per view,
   *  which is exactly the per-IP read/write fan-out this app has been bitten by. */
  const persist = useCallback((next: Set<string>) => {
    if (!hydrated.current || mode === 'local') return;
    const serialized = JSON.stringify([...next].sort());
    if (serialized === lastPersisted.current) return;
    const asClear = clearing.current && next.size === 0;
    clearing.current = false;
    void saveTutorialProgress(tutorialId, [...next], asClear ? 'clear' : undefined).then((res) => {
      if (!mounted.current) return; // landed after unmount — nothing left to update
      if (!res.ok) { setMode('unavailable'); return; } // honest downgrade, never a silent drop
      if (res.merged) {
        // Another device completed steps we did not have. Adopt the server's
        // list instead of leaving the UI showing a set the server no longer
        // holds — a silent divergence is how "my progress vanished" reports start.
        lastPersisted.current = JSON.stringify([...res.merged].sort());
        setDone(new Set(res.merged));
        return;
      }
      lastPersisted.current = serialized;
    });
  }, [tutorialId, mode]);

  const toggle = useCallback((stepId: string) => {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId); else next.add(stepId);
      return next;
    });
  }, []);
  const reset = useCallback(() => { clearing.current = true; setDone(new Set()); }, []);

  // The write rides an effect on the committed value rather than living inside
  // `toggle`/`reset`, so every path that changes `done` persists exactly once and
  // the state updaters stay pure (StrictMode double-invokes them).
  useEffect(() => {
    if (hydrated.current) persist(done);
  }, [done, persist]);

  return { done, toggle, reset, mode };
}

/**
 * ADR 0488 D1/D3 — tutorial CONTENT, server-first with the in-tree library as the
 * floor.
 *
 * Found by the whole-program `/grade-code` pass, and structurally invisible to
 * the per-phase rounds that preceded it: P1 moved the narrative into the entities
 * kernel, P6 shipped the Tutor agent which READS that kernel — but this page was
 * still rendering the in-tree `registry.ts`. So a workspace that edited a tutorial
 * (the entire point of D1) got the edited text from the Tutor and the shipped text
 * from the page: TWO user-visible sources of truth for one artifact.
 *
 * The floor is the same shape as the server's own D3 degrade: a FAILED read falls
 * back to the shipped library rather than rendering an empty catalog, because
 * "the read broke" and "this workspace has no tutorials" must never look alike.
 * The in-tree copy stays until P4/P5 retires it, held in step by the seed-drift
 * ratchet, so the floor cannot silently diverge from what the server would serve.
 */
function useTutorialCatalog(): { tutorials: TutorialData[]; degraded: boolean } {
  const [server, setServer] = useState<Map<string, Partial<TutorialData>> | null>(null);
  const [degraded, setDegraded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchTutorials().then((res) => {
      if (cancelled || !res.ok) return; // failed read ⇒ keep the floor, silently
      setDegraded(res.degraded);
      setServer(new Map(res.tutorials.map((t) => [t.id, t as Partial<TutorialData>])));
    });
    return () => { cancelled = true; };
  }, []);
  // Server order/metadata wins where present; the in-tree entry supplies the
  // phases the catalog route deliberately does not send (it is a card list).
  const tutorials = useMemo(() => {
    if (!server) return TUTORIALS;
    const bySlug = new Map(TUTORIALS.map((t) => [t.id, t]));
    const merged: TutorialData[] = [];
    for (const [id, meta] of server) {
      const local = bySlug.get(id);
      if (local) merged.push({ ...local, ...meta } as TutorialData);
    }
    // A tutorial the server does not know about is still shown from the floor —
    // dropping it would hide content the reader can legitimately open.
    for (const t of TUTORIALS) if (!server.has(t.id)) merged.push(t);
    return merged;
  }, [server]);
  return { tutorials, degraded };
}

/** One tutorial, server-first with the in-tree copy as the floor (see above). */
function useTutorialDetail(tutorialId: string | undefined): TutorialData | null {
  const local = tutorialId ? getTutorial(tutorialId) : null;
  const [server, setServer] = useState<TutorialData | null>(null);
  useEffect(() => {
    setServer(null);
    if (!tutorialId) return;
    let cancelled = false;
    void fetchTutorial(tutorialId).then((res) => {
      if (cancelled || !res.tutorial) return;
      setServer(res.tutorial as TutorialData);
    });
    return () => { cancelled = true; };
  }, [tutorialId]);
  return server ?? local;
}

/** Render **bold** spans in instruction text (the only markup tutorials use). */
function Emphasized({ text }: { text: string }): JSX.Element {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return <>{parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>))}</>;
}

function ContentBlock({ block }: { block: TutorialStepContent }): JSX.Element {
  const { t } = useTranslation('tutorials');
  switch (block.type) {
    case 'instructions':
      return (
        <ul className="u-m-0">
          {block.items.map((item, i) => <li key={i}><Emphasized text={item.text} /></li>)}
        </ul>
      );
    case 'feature-grid':
      return (
        <div className="u-grid u-gap-2">
          {block.items.map((item, i) => (
            <div key={i} className="surface-card u-p-3">
              <strong>{item.label}</strong>
              <p className="u-m-0">{item.desc}</p>
            </div>
          ))}
        </div>
      );
    case 'callout':
      return (
        <Notice variant={block.variant === 'warning' ? 'warning' : 'info'}>
          <strong>{block.title}</strong> — {block.body}
        </Notice>
      );
    case 'prose':
      return <p className="u-m-0"><Emphasized text={block.text} /></p>;
    case 'checklist':
      return (
        <ul className="u-m-0">
          {block.items.map((item, i) => (
            <li key={i} className="u-flex u-items-center u-gap-1">
              <CheckSquareIcon size={14} aria-hidden />
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <pre className="u-m-0" aria-label={t('codeSampleLabel')}><code>{block.code}</code></pre>
      );
    default:
      return <></>;
  }
}

function TutorialDetail({ tutorial }: { tutorial: TutorialData }): JSX.Element {
  const { t } = useTranslation('tutorials');
  const walkthroughsEnabled = useFeatureAccess('walkthroughs').enabled;
  const { done, toggle, reset, mode } = useTutorialProgress(tutorial.id);
  const totalSteps = useMemo(() => tutorial.phases.reduce((sum, p) => sum + p.steps.length, 0), [tutorial]);
  const doneCount = [...done].filter((id) => tutorial.phases.some((p) => p.steps.some((s) => s.id === id))).length;

  return (
    <section className="u-grid u-gap-4" data-walkthrough="tutorials.page">
      <PageHeader eyebrow={t('eyebrow')} title={tutorial.hero.title} lede={tutorial.hero.subtitle} />
      <p className="u-m-0">
        <Link className="btn-link" to="/tutorials">← {t('backToAll')}</Link>
      </p>

      <div className="surface-card u-p-4 u-grid u-gap-2">
        {tutorial.goal ? <p className="u-m-0">{tutorial.goal}</p> : null}
        <p className="u-m-0">
          {tutorial.difficulty ? <span className="chip chip--muted">{t(`difficulty_${tutorial.difficulty}`)}</span> : null}{' '}
          {tutorial.estimatedMinutes ? <span className="chip chip--muted">{t('estMinutes', { min: tutorial.estimatedMinutes })}</span> : null}{' '}
          {/* ADR 0488 P7 — a live region. Ticking a step is the whole interaction
              on this page, and it previously changed this chip in silence: a
              screen-reader user got no confirmation their work registered. */}
          <span
            className={doneCount === totalSteps ? 'chip chip--success' : 'chip chip--muted'}
            role="status"
            aria-live="polite"
          >
            {t('progressChip', { done: doneCount, total: totalSteps })}
          </span>{' '}
          {doneCount > 0 ? <Button variant="quiet" onClick={reset}>{t('resetProgress')}</Button> : null}
          {/* ADR 0488 D4 — say WHERE progress lives. 'server' is the quiet
              default and needs no chip; the other two are the honest cases. */}
          {/* The hint rides `sr-only` text as well as `title`: a title attribute
              alone is invisible to keyboard and screen-reader users, which is the
              exact defect the CDP console had to fix. Pointer users keep the
              tooltip; everyone else gets the reason in the accessible name. */}
          {mode === 'local' ? (
            <span className="chip chip--muted" title={t('progressLocalHint')}>
              {t('progressLocal')}<span className="sr-only"> — {t('progressLocalHint')}</span>
            </span>
          ) : null}
          {mode === 'unavailable' ? (
            <span className="chip chip--warning" role="status" title={t('progressUnavailableHint')}>
              {t('progressUnavailable')}<span className="sr-only"> — {t('progressUnavailableHint')}</span>
            </span>
          ) : null}
        </p>
        {tutorial.learningObjectives?.length ? (
          <div>
            <strong>{t('whatYouLearn')}</strong>
            <ul className="u-m-0">{tutorial.learningObjectives.map((o, i) => <li key={i}>{o}</li>)}</ul>
          </div>
        ) : null}
        {/* Prerequisites are SENTENCES, not status labels, so they are a list —
            not `.chip`. A chip sets `white-space: nowrap` (DESIGN.md §5.3 — chips
            are short labels), which made each prerequisite's min-content width
            the whole sentence: at 380px that pushed the page's scrollWidth to
            464px and clipped the h1 and all body copy off the right edge on 3 of
            4 tutorials (grade-ux `B2`). */}
        {tutorial.prerequisites?.length ? (
          <div className="u-grid u-gap-1">
            <strong>{t('prerequisites')}</strong>
            <ul className="u-m-0">{tutorial.prerequisites.map((p, i) => <li key={i}>{p}</li>)}</ul>
          </div>
        ) : null}
      </div>

      {tutorial.phases.map((phase) => {
        // TUT-UX-2 — a per-phase progress chip alongside the phase heading
        // (the header total tells the whole story only for short tutorials).
        const phaseDone = phase.steps.filter((s) => done.has(s.id)).length;
        return (
        <section key={phase.number} className="surface-card u-p-4 u-grid u-gap-3" aria-labelledby={`phase-${phase.number}`}>
          <header>
            <h2 id={`phase-${phase.number}`} className="u-m-0">
              {t('phaseHeading', { number: phase.number, title: phase.title })}{' '}
              <span className={phaseDone === phase.steps.length && phase.steps.length > 0 ? 'chip chip--success' : 'chip chip--muted'}>
                {t('progressChip', { done: phaseDone, total: phase.steps.length })}
              </span>
            </h2>
            {phase.description ? <p className="u-m-0">{phase.description}</p> : null}
            {/* ADR 0488 D2 — drive just THIS phase. A phase with nothing to do
                has no chainId and correctly shows no button; the whole-tutorial
                parent chain is composed from these, not the other way round. */}
            {phase.chainId && walkthroughsEnabled ? (
              <p className="u-m-0">
                <Button
                  variant="secondary" size="sm"
                  onClick={() => requestWalkthroughLaunch(phase.chainId!)}
                  title={t('showMePhaseTitle')}
                >
                  {t('showMePhase')}
                </Button>
              </p>
            ) : null}
          </header>
          {phase.goal ? (
            <Notice variant="info"><strong>{t('goalLabel')}</strong> {phase.goal}</Notice>
          ) : null}
          {phase.steps.map((step) => {
            const complete = done.has(step.id);
            return (
              <article key={step.id} className="u-grid u-gap-2">
                <header className="u-flex u-items-center u-gap-2">
                  {/* The page's PRIMARY action. Two grade-ux fixes (`B3`):
                      (1) `.tutorial-step-toggle` gives it a 32px min block size
                          — it measured 30×23, under WCAG 2.2 SC 2.5.8's 24px
                          floor, with no exemption available since it is the only
                          way to mark a step done (the `.voice-chip` precedent);
                      (2) the UNCHECKED state now carries an empty-checkbox
                          glyph. It previously rendered as a bare muted chip
                          showing "1.1", visually identical to the static
                          Beginner / ~15 min chips above it, so the core action
                          of the feature only looked interactive AFTER use. */}
                  <button
                    type="button"
                    className={`tutorial-step-toggle ${complete ? 'chip chip--success' : 'chip chip--muted'}`}
                    onClick={() => toggle(step.id)}
                    aria-pressed={complete}
                    aria-label={t('toggleStepLabel', { id: step.id, title: step.title })}
                  >
                    {complete ? <CheckIcon /> : <CheckSquareIcon size={14} aria-hidden />} {step.id}
                  </button>
                  <h3 className="u-m-0">{step.title}</h3>
                  {/* ADR 0488 D1 — prefer the `run` BINDING; fall back to the
                      legacy whole-walkthrough link so pre-0488 tutorials keep
                      their "Show me". Both launch the same player. */}
                  {(step.run?.chainId ?? step.walkthroughId) && walkthroughsEnabled ? (
                    <Button
                      variant="accent" size="sm" className="u-ml-auto"
                      onClick={() => requestWalkthroughLaunch((step.run?.chainId ?? step.walkthroughId)!)}
                      title={t('showMeTitle')}
                    >
                      {t('showMe')}
                    </Button>
                  ) : null}
                </header>
                {step.content.map((block, i) => <ContentBlock key={i} block={block} />)}
              </article>
            );
          })}
          {phase.outcome ? (
            <Notice variant="info"><strong>{t('outcomeLabel')}</strong> {phase.outcome}</Notice>
          ) : null}
        </section>
        );
      })}
    </section>
  );
}

export function TutorialsPage(): JSX.Element {
  const { t } = useTranslation('tutorials');
  const { tutorialId } = useParams();
  const tutorial = useTutorialDetail(tutorialId);

  // §4.5 collection kit (DESIGN.md rule 13): gated search + category/difficulty
  // facets over the catalog. Hooks stay above the detail early-return so the
  // hook order is stable when the route flips between list and detail.
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [difficultyFilter, setDifficultyFilter] = useState('');
  const { tutorials: catalog } = useTutorialCatalog();
  const categoryOptions = useMemo(() => [...new Set(catalog.map((tut) => tut.category))], [catalog]);
  const difficultyOptions = useMemo(() => [...new Set(catalog.flatMap((tut) => (tut.difficulty ? [tut.difficulty] : [])))], [catalog]);
  const visibleTuts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((tut) =>
      (!q || `${tut.title} ${tut.description}`.toLowerCase().includes(q)) &&
      (!categoryFilter || tut.category === categoryFilter) &&
      (!difficultyFilter || tut.difficulty === difficultyFilter));
  }, [catalog, query, categoryFilter, difficultyFilter]);
  const clearTutorialFilters = (): void => { setQuery(''); setCategoryFilter(''); setDifficultyFilter(''); };

  if (tutorialId) {
    if (!tutorial) {
      return (
        <section className="u-grid u-gap-4" data-walkthrough="tutorials.page">
          <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
          <StateCard title={t('notFoundTitle')} body={t('notFoundBody')} />
          <p className="u-m-0"><Link className="btn-link" to="/tutorials">← {t('backToAll')}</Link></p>
        </section>
      );
    }
    // GT-1 (grade-code): keyed by tutorial id — switching tutorials MUST
    // remount the detail, or the progress hook's persist effect writes the
    // previous tutorial's done-set into the new tutorial's storage key.
    return <TutorialDetail key={tutorial.id} tutorial={tutorial} />;
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="tutorials.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {catalog.length === 0 ? (
        <StateCard title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <>
          {catalog.length > 3 ? (
            <div className="filterbar" role="group" aria-label={t('filterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {categoryOptions.length > 1 ? (
                <select className="ui-input filterbar-select" aria-label={t('filterCategoryAria')} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                  <option value="">{t('allCategories')}</option>
                  {categoryOptions.map((c) => <option key={c} value={c}>{t(`category_${c}`)}</option>)}
                </select>
              ) : null}
              {difficultyOptions.length > 1 ? (
                <select className="ui-input filterbar-select" aria-label={t('filterDifficultyAria')} value={difficultyFilter} onChange={(e) => setDifficultyFilter(e.target.value)}>
                  <option value="">{t('allDifficulties')}</option>
                  {difficultyOptions.map((d) => <option key={d} value={d}>{t(`difficulty_${d}`)}</option>)}
                </select>
              ) : null}
            </div>
          ) : null}
          {visibleTuts.length === 0 ? (
            <StateCard title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={clearTutorialFilters}>{t('clearFilters')}</Button>} />
          ) : (
            <div className="u-grid u-gap-3">
              {/* Filtering changes what is on screen with no other signal, so the
                  result count is announced politely rather than left visual-only. */}
              <p className="sr-only" role="status" aria-live="polite">{t('resultCount', { count: visibleTuts.length })}</p>
              {visibleTuts.map((tut) => (
                <Link key={tut.id} to={`/tutorials/${encodeURIComponent(tut.id)}`} className="surface-card u-p-4 u-grid u-gap-1">
                  <strong>{tut.title}</strong>
                  <p className="u-m-0">{tut.description}</p>
                  <p className="u-m-0">
                    <span className="chip chip--muted">{t(`category_${tut.category}`)}</span>{' '}
                    {tut.difficulty ? <span className="chip chip--muted">{t(`difficulty_${tut.difficulty}`)}</span> : null}{' '}
                    {tut.estimatedMinutes ? <span className="chip chip--muted">{t('estMinutes', { min: tut.estimatedMinutes })}</span> : null}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
