/**
 * Manual test runner (ADR 0183 — feature-package; myndhyve Category→Suite→Case parity).
 * `/test`: pick a suite (grouped by product-area category, collapsible, with roll-up
 * progress), walk each case's steps, mark pass/fail/blocked/skip, jot bug notes. Progress is
 * DURABLE per-user via the backend (`manualTestsClient`) with a localStorage offline fallback.
 * "Copy run log" exports a Markdown block for docs/steward/MANUAL_TESTS.md. Route substrings in steps are
 * linkified. Built on the ui/ cohesion layer — tokens + Lucide icons only, light/dark safe.
 */
import { Button } from '../../ui/Button.js';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { requestWalkthroughLaunch } from '../../walkthroughs/walkthroughBus.js';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextareaField } from '../../ui/Field.js';
import { PlayIcon, CheckIcon, XIcon, BanIcon, ClipboardIcon, ArrowLeftIcon } from '../../ui/icons/index.js';
import { SUITES, CATEGORIES, CATEGORY_OF } from './suites.js';
import type { CategoryColor, TestStatus, TestSuite } from './manualTestTypes.js';
import { loadResults, saveResults, loadAllRuns, type Results } from './manualTestsClient.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';

const ACTIONS: Exclude<TestStatus, 'untested'>[] = ['pass', 'fail', 'blocked', 'skip'];
const TONE: Record<TestStatus, string> = {
  pass: 'chip--success', fail: 'chip--danger', blocked: 'chip--warning', skip: 'chip--muted', untested: 'chip--muted',
};
const MD_GLYPH: Record<TestStatus, string> = { pass: '✅', fail: '🐞', blocked: '🚫', skip: '⏭', untested: '⬜' };
const CAT_COLOR: Record<CategoryColor, string> = {
  clay: 'var(--clay)', info: 'var(--color-info)', success: 'var(--color-success)',
  warning: 'var(--color-warning)', danger: 'var(--color-danger)', accent: 'var(--clay-text)', muted: 'var(--clay-soft)',
};
const doneOf = (r: Results, s: TestSuite): number => s.cases.filter((c) => (r[c.id]?.status ?? 'untested') !== 'untested').length;

/** Linkify in-app route substrings (e.g. "/feature-toggles") into <Link>s — the myndhyve
 *  path-linkifier, scoped to route-shaped tokens so "file:line" / prose is left alone. */
function linkify(text: string): React.ReactNode {
  const parts = text.split(/(\/[a-z][a-z0-9-]*(?:\/[a-z0-9:_-]+)*)/g);
  return parts.map((p, i) =>
    /^\/[a-z]/.test(p) ? <Link key={i} to={p} className="mt-route-link">{p}</Link> : <Fragment key={i}>{p}</Fragment>);
}

export function ManualTestsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  // Gate B (ADR 0196): the QA runner is an engineering surface. The nav entry is
  // hidden via `nav.featureId`, but the /test ROUTE stays mounted (deep-linkable),
  // so the page itself renders the not-enabled state unless `developer-tools`
  // resolves enabled — the same page-level pattern every toggled feature uses.
  const devTools = useFeatureAccess('developer-tools');
  const { t } = useTranslation('manual-tests');
  const suite = SUITES.find((s) => s.key === params.get('suite')) ?? null;
  if (devTools.loading) return <div className="u-p-4"><Skeleton /></div>;
  if (!devTools.enabled) {
    return <StateCard icon={<ClipboardIcon size={20} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }
  if (!suite) return <SuiteList />;
  return <SuiteRunner key={suite.key} suite={suite} onBack={() => setParams({})} />;
}

function SuiteList(): JSX.Element {
  const { t } = useTranslation('manual-tests');
  const [runs, setRuns] = useState<Record<string, Results> | null>(null);
  // `runs === null` already meant "unknown" at render, which is why a failed
  // read had to stop returning `{}` — that rendered as "0 of N tested". But
  // null alone cannot tell LOADING from FAILED, so the tester saw plain case
  // counts with no hint their progress had not been read.
  const [runsFailed, setRunsFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void loadAllRuns().then((r) => { if (!live) return; setRuns(r); setRunsFailed(r === null); });
    return () => { live = false; };
  }, []);

  // §4.5 collection search — with 30+ suites, finding one by feature name
  // beats scanning the category groups. Empty categories collapse away.
  const [query, setQuery] = useState('');
  const visibleSuites = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SUITES;
    return SUITES.filter((s) => s.feature.toLowerCase().includes(q) || s.key.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [query]);

  const byCategory = useMemo(() => {
    const map = new Map<string, TestSuite[]>();
    for (const s of visibleSuites) { const cat = CATEGORY_OF[s.key] ?? 'other'; (map.get(cat) ?? map.set(cat, []).get(cat)!).push(s); }
    return map;
  }, [visibleSuites]);

  return (
    <section className="u-grid u-gap-4" data-walkthrough="manual-tests.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
      />
      <div className="filterbar" role="group" aria-label={t('filterGroup')}>
        <input
          type="search"
          className="ui-input filterbar-search"
          placeholder={t('filterPlaceholder')}
          aria-label={t('filterAria')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {runsFailed ? (
        <Notice variant="warning" announce={t('progressUnreadBody')}>{t('progressUnreadBody')}</Notice>
      ) : null}
      {SUITES.length === 0 ? (
        <StateCard title={t('noSuitesTitle')} body={t('noSuitesBody')} />
      ) : visibleSuites.length === 0 ? (
        <StateCard
          title={t('noMatchTitle')}
          body={t('noMatchBody')}
          action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearSearch')}</Button>}
        />
      ) : (
        CATEGORIES.filter((c) => byCategory.get(c.id)?.length).map((cat) => {
          const suites = byCategory.get(cat.id) ?? [];
          const total = suites.reduce((n, s) => n + s.cases.length, 0);
          const done = runs ? suites.reduce((n, s) => n + doneOf(runs[s.key] ?? {}, s), 0) : 0;
          return (
            <details key={cat.id} className="mt-cat" open>
              <summary className="mt-cat__head">
                <span className="mt-cat__dot" aria-hidden="true" style={{ background: CAT_COLOR[cat.colorKey] }} />
                <strong>{cat.title}</strong>
                <span className="u-text-muted">{cat.description}</span>
                <span className="chip chip--muted u-ms-auto">
                  {runs ? t('categoryProgress', { done, total }) : t('casesCount', { count: total })}
                </span>
              </summary>
              <div className="card-grid mt-cat__grid">
                {suites.map((s) => {
                  const r = runs?.[s.key] ?? {};
                  const d = runs ? doneOf(r, s) : 0;
                  return (
                    <Link key={s.key} to={`?suite=${s.key}`} className="surface-card u-flex u-flex-col u-gap-2">
                      <span className="u-flex u-gap-2 u-items-center">
                        <strong>{s.feature}</strong>
                        {s.toggle.off ? <span className="chip chip--warning">{t('offEnableFirst')}</span> : null}
                        {runs && d > 0 ? <span className="chip chip--muted u-ms-auto">{t('categoryProgress', { done: d, total: s.cases.length })}</span> : null}
                      </span>
                      <span className="u-text-muted">{s.description}</span>
                      <span className="u-text-muted">{t('casesCount', { count: s.cases.length })} · {s.route}</span>
                    </Link>
                  );
                })}
              </div>
            </details>
          );
        })
      )}
    </section>
  );
}

function SuiteRunner({ suite, onBack }: { suite: TestSuite; onBack: () => void }): JSX.Element {
  const { t } = useTranslation('manual-tests');
  const walkthroughsEnabled = useFeatureAccess('walkthroughs').enabled;
  // ADR 0368 P5 — the completed chip on tour-backed cases.
  const [walkthroughDone, setWalkthroughDone] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!walkthroughsEnabled) return;
    let live = true;
    void fetch(`${config.baseUrl}/host/openwop-app/walkthroughs/progress`, fetchOpts({ headers: authedHeaders() }))
      .then(async (r) => (r.ok ? (await r.json()) as { progress: Array<{ walkthroughId: string; status: string }> } : null))
      .then((body) => {
        if (live && body) setWalkthroughDone(new Set(body.progress.filter((p) => p.status === 'completed').map((p) => p.walkthroughId)));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [walkthroughsEnabled]);
  const [results, setResults] = useState<Results | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'untested' | 'failed'>('all');

  useEffect(() => { let live = true; void loadResults(suite.key).then((r) => { if (live) setResults(r); }); return () => { live = false; }; }, [suite.key]);

  // A result the SERVER never accepted must not look recorded. The save used
  // to run inside the state updater as `void saveResults(...)` — a side effect
  // in a reducer, whose outcome nothing could observe. It is hoisted out so the
  // failure has somewhere to go.
  const set = useCallback((caseId: string, patch: Partial<Results[string]>): void => {
    setResults((prev) => {
      const base = prev ?? {};
      const cur = base[caseId] ?? { status: 'untested' as TestStatus, note: '', ts: '' };
      const next: Results = { ...base, [caseId]: { ...cur, ...patch, ts: new Date().toISOString() } };
      void saveResults(suite.key, next).then((outcome) => { setSaveFailed(!outcome.ok); });
      return next;
    });
  }, [suite.key]);

  const counts = useMemo(() => {
    const c = { pass: 0, fail: 0, blocked: 0, skip: 0, untested: 0 };
    for (const tc of suite.cases) c[(results?.[tc.id]?.status ?? 'untested')] += 1;
    return c;
  }, [results, suite.cases]);
  const done = suite.cases.length - counts.untested;
  const pct = suite.cases.length ? Math.round((done / suite.cases.length) * 100) : 0;

  const copyRunLog = useCallback((): void => {
    const r = results ?? {};
    const today = new Date().toISOString().slice(0, 10);
    const lines = [`### ${suite.feature} — \`/test?suite=${suite.key}\``, '', `#### Run log`, `- ${today} · run by <you>`];
    for (const tc of suite.cases) {
      const g = MD_GLYPH[r[tc.id]?.status ?? 'untested'];
      lines.push(`  - \`${tc.id}\` ${g} ${tc.title}${r[tc.id]?.note ? ` — ${r[tc.id]!.note}` : ''}`);
    }
    const fails = suite.cases.filter((tc) => { const s = r[tc.id]?.status; return s === 'fail' || s === 'blocked'; });
    if (fails.length) {
      lines.push('', `#### Open bugs`);
      for (const tc of fails) lines.push(`- [ ] \`${tc.id}\` ${suite.feature} — ${r[tc.id]?.note || '(describe the failure)'}`);
    }
    void copyToClipboard(lines.join('\n'), t('runLogCopied'));
  }, [results, suite, t]);

  const visible = (results !== null ? suite.cases : []).filter((tc) => {
    const st = results?.[tc.id]?.status ?? 'untested';
    if (filter === 'untested') return st === 'untested';
    if (filter === 'failed') return st === 'fail' || st === 'blocked';
    return true;
  });

  return (
    <section>
      {saveFailed ? (
        <Notice variant="error" announce={t('saveFailedBody')}>{t('saveFailedBody')}</Notice>
      ) : null}
      <PageHeader
        eyebrow={t('runnerEyebrow')} title={suite.feature} lede={suite.description}
        actions={<>
          <Button variant="secondary" onClick={onBack}><ArrowLeftIcon size={13} /> {t('allSuites')}</Button>
          <Button variant="accent-solid" onClick={copyRunLog}><ClipboardIcon size={15} /> {t('copyRunLog')}</Button>
        </>}
      />

      {suite.toggle.off ? (
        <Notice variant="warning">
          <div>
            <strong>{t('enableFirstTitle')}</strong>
            <ol className="u-mt-2">{suite.toggle.howToEnable.map((s, i) => <li key={i}>{linkify(s)}</li>)}</ol>
            {suite.toggle.howToRevert?.length ? <p className="u-text-muted u-mt-1">{t('revert')}: {suite.toggle.howToRevert.join('; ')}</p> : null}
          </div>
        </Notice>
      ) : null}

      <div className="surface-card mt-summary" style={{ marginTop: 'var(--space-3)' }}>
        <div className="mt-meter" role="img" aria-label={t('meterLabel', { pass: counts.pass, fail: counts.fail, blocked: counts.blocked, skip: counts.skip, untested: counts.untested })}>
          {(['pass', 'fail', 'blocked', 'skip'] as const).map((k) => counts[k]
            ? <span key={k} className={`mt-meter__seg mt-meter__seg--${k}`} style={{ width: `${(counts[k] / suite.cases.length) * 100}%` }} />
            : null)}
        </div>
        <div className="mt-summary__row">
          <span className="chip chip--success">{t('countPass', { count: counts.pass })}</span>
          <span className="chip chip--danger">{t('countFail', { count: counts.fail })}</span>
          <span className="chip chip--warning">{t('countBlocked', { count: counts.blocked })}</span>
          <span className="chip chip--muted">{t('countUntested', { count: counts.untested })}</span>
          <span className="mt-summary__pct">{t('percentComplete', { pct, done, total: suite.cases.length })}</span>
          <div className="mt-filter">
            {(['all', 'untested', 'failed'] as const).map((f) => (
              <Button variant="primary" key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(`filter_${f}`)}</Button>
            ))}
          </div>
        </div>
      </div>

      {results === null ? (
        <div style={{ marginTop: 'var(--space-3)' }}><Skeleton /></div>
      ) : (
        <div className="u-flex u-flex-col u-gap-3" style={{ marginTop: 'var(--space-3)' }}>
          {visible.map((tc) => {
            const r = results[tc.id] ?? { status: 'untested' as TestStatus, note: '', ts: '' };
            return (
              <article key={tc.id} className={`surface-card mt-case mt-case--${r.status}`}>
                <header className="mt-case__head">
                  <span className="chip chip--muted" title={t(`priorityHint_${tc.priority}`)}>{tc.priority}</span>
                  {tc.blocker ? <span className="chip chip--danger">{t('blocker')}</span> : null}
                  <strong>{tc.id} · {tc.title}</strong>
                  {tc.walkthroughId && walkthroughsEnabled ? (
                    <Button
                      variant="accent" size="sm"
                      onClick={() => requestWalkthroughLaunch(tc.walkthroughId!)}
                      title={t('playWalkthroughTitle')}
                    >
                      <PlayIcon size={13} aria-hidden /> {t('playWalkthrough')}
                    </Button>
                  ) : null}
                  {tc.walkthroughId && walkthroughsEnabled && walkthroughDone.has(tc.walkthroughId) ? (
                    <span className="chip chip--success">{t('walkthroughCompletedChip')}</span>
                  ) : null}
                  {r.status !== 'untested' ? <span className={`chip ${TONE[r.status]} u-ms-auto`}>{t(`status_${r.status}`)}</span> : null}
                </header>

                {tc.preconditions.length ? (
                  <p className="u-text-muted u-mt-2"><strong>{t('preconditions')}:</strong> {tc.preconditions.map((p, i) => <Fragment key={i}>{i ? '; ' : ' '}{linkify(p)}</Fragment>)}</p>
                ) : null}

                <ol className="mt-steps">
                  {tc.steps.map((st, i) => (
                    <li key={i} className="mt-step">
                      <span className="mt-step__num">{i + 1}</span>
                      <span>
                        <span className="mt-step__action">{linkify(st.action)}</span>
                        <span className="mt-step__expect">{linkify(st.expect)}</span>
                      </span>
                    </li>
                  ))}
                </ol>

                <div className="mt-status u-mt-3">
                  {ACTIONS.map((a) => (
                    <button type="button" key={a} className={`mt-status-btn mt-status-btn--${a}`}
                      onClick={() => set(tc.id, { status: r.status === a ? 'untested' : a })} aria-pressed={r.status === a}>
                      {a === 'pass' ? <CheckIcon size={14} /> : a === 'fail' ? <XIcon size={14} /> : a === 'blocked' ? <BanIcon size={14} /> : null}
                      {t(`status_${a}`)}
                    </button>
                  ))}
                </div>

                <div className="u-mt-3">
                  <TextareaField label={t('notesLabel')} value={r.note} rows={2} placeholder={t('notesPlaceholder')}
                    onChange={(e) => set(tc.id, { note: e.target.value })} />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
