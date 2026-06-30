/**
 * `/demo-data` (Settings → Example data) — the example-data seeding dashboard.
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
  clearExampleData,
  getExampleDataStatus,
  runExampleDataSeed,
  type ExampleDataStep,
  type RunResult,
  type StepResult,
} from '../client/exampleDataClient.js';

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState<null | 'seed' | 'clear'>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getExampleDataStatus();
      setSteps(s);
      setSelected((prev) => (prev.size === 0 ? new Set(s.map((x) => x.id)) : prev));
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
    try {
      const stepIds = all ? undefined : [...selected];
      const r = await runExampleDataSeed({ ...(stepIds ? { steps: stepIds } : {}), dryRun });
      setResult(r);
      if (!dryRun) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      const r = await clearExampleData(ids.length ? { steps: ids } : {});
      setResult(r);
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
    <section>
      <PageHeader
        eyebrow={t('exampleDataEyebrow')}
        title={t('exampleDataTitle')}
        lede={t('exampleDataLede')}
      />

      {error ? <Notice variant="error">{error}</Notice> : null}

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
          <button type="button" className="btn-accent-solid" disabled={busy !== null || (steps?.length ?? 0) === 0} onClick={() => void onSeed(true)}>
            <DatabaseIcon size={14} /> {busy === 'seed' ? t('common:loading') : t('loadAllExampleData')}
          </button>
          <button type="button" className="btn" disabled={busy !== null || selected.size === 0} onClick={() => void onSeed(false)}>
            <CheckIcon size={14} /> {t('loadSelected', { n: formatNumber(selected.size) })}
          </button>
          <button type="button" className="btn" disabled={busy !== null || (steps?.length ?? 0) === 0} onClick={() => void refresh()}>
            <RotateCwIcon size={14} /> {t('common:refresh')}
          </button>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => void onClear()} title={t('clearTitle')}>
            <TrashIcon size={14} /> {busy === 'clear' ? t('clearing') : t('clearExampleData')}
          </button>
        </div>

        {result ? <ResultList result={result} /> : null}
      </div>
    </section>
  );
}
