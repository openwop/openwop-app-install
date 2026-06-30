/**
 * Manual test runner (`/manual-tests` skill). Human-run feature tests at
 * `/test?suite=<key>`: walk each case's steps, mark pass/fail/blocked/skip, jot
 * bug notes; progress persists to localStorage. "Copy run log" exports a
 * Markdown block for MANUAL_TESTS.md. Built on the ui/ cohesion layer — tokens
 * + Lucide icons only, light/dark safe.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../ui/PageHeader.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { TextareaField } from '../ui/Field.js';
import { toast } from '../ui/toast.js';
import { CheckIcon, XIcon, BanIcon, ClipboardIcon, ArrowLeftIcon } from '../ui/icons/index.js';
import { SUITES } from './suites.js';
import type { TestStatus, TestSuite } from './manualTestTypes.js';

interface Result { status: TestStatus; note: string; ts: string }
type Results = Record<string, Result>;

const PREFIX = 'openwop.manualTests.';
const ACTIONS: { key: Exclude<TestStatus, 'untested'>; label: string }[] = [
  { key: 'pass', label: 'Pass' },
  { key: 'fail', label: 'Fail' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'skip', label: 'Skip' },
];
const TONE: Record<TestStatus, string> = {
  pass: 'chip--success', fail: 'chip--danger', blocked: 'chip--warning', skip: 'chip--muted', untested: 'chip--muted',
};
const MD_GLYPH: Record<TestStatus, string> = {
  pass: '✅', fail: '🐞', blocked: '🚫', skip: '⏭', untested: '⬜',
};

function loadResults(key: string): Results {
  try { return JSON.parse(localStorage.getItem(PREFIX + key) ?? '{}') as Results; } catch { return {}; }
}
function saveResults(key: string, r: Results): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(r)); } catch { /* storage disabled — progress is best-effort */ }
}

export function ManualTestPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const suite = SUITES.find((s) => s.key === params.get('suite')) ?? null;
  if (!suite) return <SuiteList />;
  return <SuiteRunner key={suite.key} suite={suite} onBack={() => setParams({})} />;
}

function SuiteList(): JSX.Element {
  return (
    <section>
      <PageHeader eyebrow="QA" title="Manual tests" lede="Human-run feature & toggle tests. Pick a suite to start." />
      {SUITES.length === 0 ? (
        <StateCard title="No suites yet" body="Run the /manual-tests skill to author feature suites." />
      ) : (
        <div className="card-grid" style={{ marginTop: 'var(--space-4)' }}>
          {SUITES.map((s) => (
            <Link key={s.key} to={`?suite=${s.key}`} className="surface-card u-flex u-flex-col u-gap-2">
              <span className="u-flex u-gap-2 u-items-center">
                <strong>{s.feature}</strong>
                {s.toggle.off ? <span className="chip chip--warning">OFF — enable first</span> : null}
              </span>
              <span className="u-text-muted">{s.description}</span>
              <span className="u-text-muted">{s.cases.length} case{s.cases.length === 1 ? '' : 's'} · {s.route}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function SuiteRunner({ suite, onBack }: { suite: TestSuite; onBack: () => void }): JSX.Element {
  const [results, setResults] = useState<Results>(() => loadResults(suite.key));
  const [filter, setFilter] = useState<'all' | 'untested' | 'failed'>('all');

  const set = (caseId: string, patch: Partial<Result>): void => {
    setResults((prev) => {
      const cur = prev[caseId] ?? { status: 'untested' as TestStatus, note: '', ts: '' };
      const next: Results = { ...prev, [caseId]: { ...cur, ...patch, ts: new Date().toISOString() } };
      saveResults(suite.key, next);
      return next;
    });
  };

  const counts = useMemo(() => {
    const c = { pass: 0, fail: 0, blocked: 0, skip: 0, untested: 0 };
    for (const tc of suite.cases) c[(results[tc.id]?.status ?? 'untested')] += 1;
    return c;
  }, [results, suite.cases]);
  const done = suite.cases.length - counts.untested;
  const pct = suite.cases.length ? Math.round((done / suite.cases.length) * 100) : 0;

  const visible = suite.cases.filter((tc) => {
    const st = results[tc.id]?.status ?? 'untested';
    if (filter === 'untested') return st === 'untested';
    if (filter === 'failed') return st === 'fail' || st === 'blocked';
    return true;
  });

  const copyRunLog = (): void => {
    const today = new Date().toISOString().slice(0, 10);
    const lines = [`### ${suite.feature} — \`/test?suite=${suite.key}\``, '', `#### Run log`, `- ${today} · run by <you>`];
    for (const tc of suite.cases) {
      const r = results[tc.id];
      const g = MD_GLYPH[r?.status ?? 'untested'];
      lines.push(`  - \`${tc.id}\` ${g} ${tc.title}${r?.note ? ` — ${r.note}` : ''}`);
    }
    const fails = suite.cases.filter((tc) => { const s = results[tc.id]?.status; return s === 'fail' || s === 'blocked'; });
    if (fails.length) {
      lines.push('', `#### Open bugs`);
      for (const tc of fails) lines.push(`- [ ] \`${tc.id}\` ${suite.feature} — ${results[tc.id]?.note || '(describe the failure)'}`);
    }
    void navigator.clipboard.writeText(lines.join('\n')).then(() => toast.success('Run log copied as Markdown')).catch(() => toast.error('Copy failed'));
  };

  return (
    <section>
      <PageHeader
        eyebrow="QA · manual test"
        title={suite.feature}
        lede={suite.description}
        actions={<>
          <button className="secondary" onClick={onBack}><ArrowLeftIcon size={13} /> All suites</button>
          <button className="btn-accent-solid" onClick={copyRunLog}><ClipboardIcon size={15} /> Copy run log</button>
        </>}
      />

      {suite.toggle.off ? (
        <Notice variant="warning">
          <div>
            <strong>This feature is OFF by default — enable it first.</strong>
            <ol className="u-mt-2">{suite.toggle.howToEnable.map((s, i) => <li key={i}>{s}</li>)}</ol>
            {suite.toggle.howToRevert?.length ? <p className="u-text-muted u-mt-1">Revert: {suite.toggle.howToRevert.join('; ')}</p> : null}
          </div>
        </Notice>
      ) : null}

      <div className="surface-card mt-summary" style={{ marginTop: 'var(--space-3)' }}>
        <div className="mt-meter" role="img"
          aria-label={`${counts.pass} passed, ${counts.fail} failed, ${counts.blocked} blocked, ${counts.skip} skipped, ${counts.untested} untested`}>
          {(['pass', 'fail', 'blocked', 'skip'] as const).map((k) => counts[k]
            ? <span key={k} className={`mt-meter__seg mt-meter__seg--${k}`} style={{ width: `${(counts[k] / suite.cases.length) * 100}%` }} />
            : null)}
        </div>
        <div className="mt-summary__row">
          <span className="chip chip--success">{counts.pass} pass</span>
          <span className="chip chip--danger">{counts.fail} fail</span>
          <span className="chip chip--warning">{counts.blocked} blocked</span>
          <span className="chip chip--muted">{counts.untested} untested</span>
          <span className="mt-summary__pct">{pct}% complete · {done}/{suite.cases.length}</span>
          <div className="mt-filter">
            {(['all', 'untested', 'failed'] as const).map((f) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="u-flex u-flex-col u-gap-3" style={{ marginTop: 'var(--space-3)' }}>
        {visible.map((tc) => {
          const r = results[tc.id] ?? { status: 'untested' as TestStatus, note: '', ts: '' };
          return (
            <article key={tc.id} className={`surface-card mt-case mt-case--${r.status}`}>
              <header className="mt-case__head">
                <span className="chip chip--muted">{tc.priority}</span>
                {tc.blocker ? <span className="chip chip--danger">BLOCKER</span> : null}
                <strong>{tc.id} · {tc.title}</strong>
                {r.status !== 'untested' ? <span className={`chip ${TONE[r.status]}`} style={{ marginInlineStart: 'auto' }}>{r.status}</span> : null}
              </header>

              {tc.preconditions.length ? (
                <p className="u-text-muted u-mt-2"><strong>Preconditions:</strong> {tc.preconditions.join('; ')}</p>
              ) : null}

              <ol className="mt-steps">
                {tc.steps.map((st, i) => (
                  <li key={i} className="mt-step">
                    <span className="mt-step__num">{i + 1}</span>
                    <span>
                      <span className="mt-step__action">{st.action}</span>
                      <span className="mt-step__expect">{st.expect}</span>
                    </span>
                  </li>
                ))}
              </ol>

              <div className="mt-status u-mt-3">
                {ACTIONS.map((a) => (
                  <button key={a.key}
                    className={`mt-status-btn mt-status-btn--${a.key}`}
                    onClick={() => set(tc.id, { status: r.status === a.key ? 'untested' : a.key })}
                    aria-pressed={r.status === a.key}>
                    {a.key === 'pass' ? <CheckIcon size={14} /> : a.key === 'fail' ? <XIcon size={14} /> : a.key === 'blocked' ? <BanIcon size={14} /> : null}
                    {a.label}
                  </button>
                ))}
              </div>

              <div className="u-mt-3">
                <TextareaField label="Notes / bug" value={r.note} rows={2}
                  placeholder="What happened, where (file:line if known)…"
                  onChange={(e) => set(tc.id, { note: e.target.value })} />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
