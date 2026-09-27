/**
 * `/example-data` (Settings → Example data) — the example-data seeding dashboard.
 *
 * Renders one row per example data type the backend's seeder registry reports
 * (`GET /demo/status`), each with its live "N present" count and a checkbox.
 * Load all / load selected (with a Dry-run preview), or clear, then see honest
 * per-step results + a summary. The dashboard derives entirely from the
 * registry, so a new example data type appears here with zero changes to this file.
 *
 * Everything here is EXPLICIT + user-triggered: nothing is seeded behind the
 * user's back, and a clean / white-label install starts empty until someone
 * clicks Load. Modelled on myndhyve's SeedDataPanel, in openwop primitives.
 *
 * @see ../client/exampleDataClient.ts
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { formatNumber } from '../i18n/format.js';
import { Notice } from '../ui/Notice.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { CheckIcon, RotateCwIcon, TrashIcon, DatabaseIcon } from '../ui/icons/index.js';
import {
  clearExampleDataStream,
  getExampleDataStatus,
  runExampleDataSeed,
  runExampleDataSeedStream,
  provisionDemoTenant,
  type ExampleDataStep,
  type RunResult,
  type StepResult,
} from '../client/exampleDataClient.js';

/** Build a RunResult from the step results streamed so far — drives the live
 *  progress list as each seeder lands (ADR 0292). */
function liveResult(results: StepResult[]): RunResult {
  return {
    success: true,
    dryRun: false,
    results: [...results],
    summary: {
      created: results.filter((r) => r.action === 'created').length,
      skipped: results.filter((r) => r.action === 'skipped').length,
      cleared: results.filter((r) => r.action === 'cleared').length,
      errors: results.filter((r) => r.action === 'error').length,
      total: results.length,
    },
  };
}

function actionChip(action: StepResult['action']): string {
  switch (action) {
    case 'created': return 'chip chip--success';
    case 'cleared': return 'chip chip--accent';
    case 'error': return 'chip chip--danger';
    default: return 'chip chip--muted'; // skipped
  }
}

const ACTION_LABEL = {
  created: 'actionCreated',
  cleared: 'actionCleared',
  error: 'actionError',
  skipped: 'actionSkipped',
} as const;

function ResultList({ result }: { result: RunResult }): JSX.Element {
  const { t } = useTranslation('settings');
  const { summary } = result;
  return (
    <div className="u-mt-3" role="status" aria-live="polite">
      {result.dryRun ? <Notice variant="info">{t('dryRunNotice')}</Notice> : null}
      <div className="action-bar u-gap-2 u-wrap u-mb-2">
        {summary.created > 0 ? <span className="chip chip--success">{t('summaryCreated', { count: summary.created, n: formatNumber(summary.created) })}</span> : null}
        {summary.cleared > 0 ? <span className="chip chip--accent">{t('summaryCleared', { count: summary.cleared, n: formatNumber(summary.cleared) })}</span> : null}
        {summary.skipped > 0 ? <span className="chip chip--muted">{t('summarySkipped', { count: summary.skipped, n: formatNumber(summary.skipped) })}</span> : null}
        {summary.errors > 0 ? <span className="chip chip--danger">{t('summaryErrors', { count: summary.errors, n: formatNumber(summary.errors) })}</span> : null}
      </div>
      <ul className="demodata-result-list">
        {result.results.map((r) => (
          <li key={r.step} className="action-bar u-gap-2 u-items-center">
            <span className={actionChip(r.action)}>{t(ACTION_LABEL[r.action])}</span>
            <strong>{r.label}</strong>
            <span className="demodata-muted">{r.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ExampleDataPage(): JSX.Element {
  const { t } = useTranslation('settings');
  const [steps, setSteps] = useState<ExampleDataStep[] | null>(null);
  // Whether seeding is available on this deployment (DUR-3/ADR 0195: opt-in
  // under the enterprise posture). Clearing existing data is never gated.
  const [seedEnabled, setSeedEnabled] = useState(true);
  const [superadmin, setSuperadmin] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState<null | 'seed' | 'clear' | 'provision'>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getExampleDataStatus();
      setSteps(s.steps);
      setSeedEnabled(s.enabled);
      setSuperadmin(s.superadmin);
      setSelected((prev) => (prev.size === 0 ? new Set(s.steps.map((x) => x.id)) : prev));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const onSeed = async (all: boolean) => {
    setBusy('seed'); setError(null); setResult(null);
    const stepIds = all ? undefined : [...selected];
    try {
      // Dry-run previews from counts (fast) — plain JSON. A real seed STREAMS so
      // the full reseed shows live progress and never trips the timeouts (ADR 0292).
      if (dryRun) {
        setResult(await runExampleDataSeed({ ...(stepIds ? { steps: stepIds } : {}), dryRun: true }));
        return;
      }
      const collected: StepResult[] = [];
      const final = await runExampleDataSeedStream({ ...(stepIds ? { steps: stepIds } : {}) }, (e) => {
        if (e.type === 'step') { collected.push(e); setResult(liveResult(collected)); }
      });
      setResult({ success: final.success, dryRun: false, results: collected, summary: final.summary });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onProvision = async () => {
    if (!(await confirm({ title: t('provisionConfirm') }))) return;
    setBusy('provision'); setError(null); setResult(null);
    try {
      const collected: StepResult[] = [];
      const final = await provisionDemoTenant((e) => {
        if (e.type === 'step') { collected.push(e); setResult(liveResult(collected)); }
      });
      setResult({ success: final.success, dryRun: false, results: collected, summary: final.summary });
      window.dispatchEvent(new Event('openwop:pinned-agents-changed'));
      await refresh();
    } catch (err) {
      // Provisioning is superadmin-only — the server enforces it; surface a 403
      // as a helpful message (the AuditLogPage forbidden pattern).
      const msg = err instanceof Error ? err.message : String(err);
      setError(/forbidden|superadmin|403/i.test(msg) ? t('provisionForbidden') : msg);
    } finally {
      setBusy(null);
    }
  };

  const onClear = async () => {
    const ids = [...selected];
    const label = ids.length ? ids.join(', ') : t('clearAllFallback');
    if (!(await confirm({ title: t('clearConfirm', { label }), danger: true }))) return;
    setBusy('clear'); setError(null); setResult(null);
    try {
      // Stream the clear so the full cascade (roster deletes, thousands of rows)
      // never trips the Firebase `/api` ~60s cap and shows live progress — the
      // same path the reseed uses (ADR 0292 / ADR 0321).
      const collected: StepResult[] = [];
      const final = await clearExampleDataStream(ids.length ? { steps: ids } : {}, (e) => {
        if (e.type === 'step') { collected.push(e); setResult(liveResult(collected)); }
      });
      setResult({ success: final.success, dryRun: false, results: collected, summary: final.summary });
      // Clearing agents deletes roster members that may be pinned — tell the
      // sidebar to re-read so a now-dead pin drops out immediately (ADR 0023).
      window.dispatchEvent(new Event('openwop:pinned-agents-changed'));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-walkthrough="example-data.page">
      <PageHeader
        eyebrow={t('exampleDataEyebrow')}
        title={t('exampleDataTitle')}
        lede={t('exampleDataLede')}
      />

      {error ? <Notice variant="error">{error}</Notice> : null}
      {!seedEnabled ? <Notice variant="info">{t('seedDisabledNotice')}</Notice> : null}

      <div className="surface-card u-mt-3">
        <h2 className="u-fs-16 u-mt-0">{t('typesHeading')}</h2>
        <p className="demodata-muted">{t('typesIntro')}</p>

        {steps === null ? (
          <div className="u-grid u-gap-2 u-mt-2">
            <Skeleton height={44} /><Skeleton height={44} />
          </div>
        ) : steps.length === 0 ? (
          <StateCard icon={<DatabaseIcon />} title={t('noTypesTitle')} body={t('noTypesBody')} />
        ) : (
          <ul className="u-list-none u-mbox-t2 u-p-0 u-grid u-gap-2">
            {steps.map((s) => (
              <li key={s.id} className="surface-card u-pad-2-3">
                <label className="u-flex u-gap-2-5 u-items-start u-cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                    aria-label={t('selectAria', { label: s.label })}
                    className="demodata-check"
                  />
                  <span className="u-flex-1 u-minw-0">
                    <span className="action-bar u-gap-2 u-items-center">
                      <strong>{s.label}</strong>
                      <span className={s.count > 0 ? 'chip chip--success' : 'chip chip--muted'}>{t('countPresent', { n: formatNumber(s.count) })}</span>
                    </span>
                    <span className="demodata-desc">{s.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="action-bar u-gap-3 u-wrap u-mt-3 u-items-center">
          <label className="demodata-dryrun-label">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="u-w-auto u-flex-auto" /> {t('dryRunLabel')}
          </label>
          <Button variant="accent-solid" disabled={busy !== null || !seedEnabled || (steps?.length ?? 0) === 0} onClick={() => void onSeed(true)}>
            <DatabaseIcon size={14} /> {busy === 'seed' ? t('common:loading') : t('loadAllExampleData')}
          </Button>
          <Button variant="primary" disabled={busy !== null || !seedEnabled || selected.size === 0} onClick={() => void onSeed(false)}>
            <CheckIcon size={14} /> {t('loadSelected', { n: formatNumber(selected.size) })}
          </Button>
          {superadmin ? (
            <Button variant="primary" disabled={busy !== null || !seedEnabled} onClick={() => void onProvision()} title={t('provisionTitle')}>
              <DatabaseIcon size={14} /> {busy === 'provision' ? t('provisioning') : t('provisionExampleData')}
            </Button>
          ) : null}
          <Button variant="primary" disabled={busy !== null || (steps?.length ?? 0) === 0} onClick={() => void refresh()}>
            <RotateCwIcon size={14} /> {t('common:refresh')}
          </Button>
          <Button variant="secondary" disabled={busy !== null} onClick={() => void onClear()} title={t('clearTitle')}>
            <TrashIcon size={14} /> {busy === 'clear' ? t('clearing') : t('clearExampleData')}
          </Button>
        </div>

        {result ? <ResultList result={result} /> : null}
      </div>
    </section>
  );
}
