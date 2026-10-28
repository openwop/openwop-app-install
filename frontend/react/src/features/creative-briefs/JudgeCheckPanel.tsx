/**
 * ADR 0945 P2 — check the fidelity judge on a real model. An admin picks one of
 * the workspace's own AI keys, its provider and a vision model; the server sends
 * four made-up product edits (unchanged, recoloured, logo swapped, extra part)
 * and reports whether the model caught each one. Prefilled from the workspace's
 * default AI provider; the key value never reaches the browser, only its name.
 * Nothing is fetched until the admin opens it.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { getAiDefault, listStoredRefs } from '../../byok/lib/byokClient.js';
import { runJudgeCheck, type JudgeCheckCase, type JudgeCheckReport, type JudgeCheckSpec } from './creativeBriefsClient.js';

const PROVIDERS: ReadonlyArray<JudgeCheckSpec['provider']> = ['anthropic', 'google', 'openai'];

/** "429 RESOURCE_EXHAUSTED": what the provider said, as codes only. */
const providerDetail = (e: NonNullable<JudgeCheckCase['providerError']>): string =>
  [e.status !== undefined ? String(e.status) : '', ...e.codes].filter(Boolean).join(' ') || '?';

export function JudgeCheckPanel({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('creative-briefs');
  // null until the key names load; a failed load is said, never shown as "no keys".
  const [refs, setRefs] = useState<readonly string[] | null>(null);
  const [provider, setProvider] = useState<JudgeCheckSpec['provider']>('anthropic');
  const [model, setModel] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<JudgeCheckReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Closed until asked for: nothing about keys is fetched for a page visit.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    void listStoredRefs().then((r) => { if (live) setRefs(r); }).catch(() => { if (live) setError(t('judgeCheckError')); });
    void getAiDefault().then((d) => {
      if (!live || !d) return;
      setProvider(d.provider); setModel(d.model); setCredentialRef(d.credentialRef);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [open, t]);

  const canRun = !busy && model.trim().length > 0 && credentialRef.length > 0;

  const run = async (): Promise<void> => {
    setBusy(true); setError(null); setReport(null);
    try {
      setReport(await runJudgeCheck(orgId, { provider, model: model.trim(), credentialRef }));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('judgeCheckError'));
    } finally { setBusy(false); }
  };

  const missed = report ? report.cases.filter((c) => !c.passed).length : 0;
  const summary = !report ? ''
    : !report.completed ? t('judgeCheckStopped')
    : report.passed ? t('judgeCheckPassed', { total: report.cases.length })
    : t('judgeCheckMissed', { missed, total: report.cases.length });

  return (
    <section className="u-grid u-gap-1" aria-labelledby="judge-check-title">
      <h3 id="judge-check-title" className="u-fs-14 u-m-0">{t('judgeCheckTitle')}</h3>
      <p className="field-help u-m-0">{t('judgeCheckIntro')}</p>
      {!open ? (
        <div><Button variant="secondary" onClick={() => setOpen(true)}>{t('judgeCheckOpen')}</Button></div>
      ) : refs === null ? null : refs.length === 0 ? (
        <Notice variant="info">{t('judgeCheckNoKeys')}</Notice>
      ) : (
        <>
          <SelectField label={t('judgeCheckProvider')} value={provider} onChange={(e) => setProvider(e.target.value as JudgeCheckSpec['provider'])}>
            {PROVIDERS.map((p) => <option key={p} value={p}>{t(`judgeCheckProvider_${p}`)}</option>)}
          </SelectField>
          <TextField label={t('judgeCheckModel')} help={t('judgeCheckModelHelp')} value={model} onChange={(e) => setModel(e.target.value)} />
          <SelectField label={t('judgeCheckKey')} value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)}>
            <option value="">{t('judgeCheckKeyPlaceholder')}</option>
            {refs.map((r) => <option key={r} value={r}>{r}</option>)}
          </SelectField>
          <div>
            <Button variant="primary" disabled={!canRun} aria-busy={busy} onClick={() => void run()}>
              {busy ? t('judgeCheckRunning') : t('judgeCheckRun')}
            </Button>
          </div>
        </>
      )}
      {error !== null ? <Notice variant="warning" announce={error}>{error}</Notice> : null}
      {report ? (
        <>
          <Notice variant={report.passed ? 'success' : 'warning'} announce={summary}>{summary}</Notice>
          <p className="field-help u-m-0">{t('judgeCheckWho', { provider: report.provider, model: report.model ?? '', calls: report.calls })}</p>
          <ul className="u-list-plain u-grid u-gap-1 u-m-0 u-p-0" aria-label={t('judgeCheckCases')}>
            {report.cases.map((c) => (
              <li key={c.id} className="u-flex u-flex-wrap u-items-center u-gap-2">
                <span className={`chip ${c.passed ? 'chip--success' : 'chip--danger'}`}>{c.passed ? t('judgeCheckCaseOk') : t('judgeCheckCaseMiss')}</span>
                <span>{t(`judgeCheckCase_${c.id}`, { defaultValue: c.id })}</span>
                <span className="u-text-muted">
                  {c.error ? t(`judgeCheckError_${c.error}`) : t('judgeCheckCaseResult', { expected: t(`judgeCheckExpect_${c.expected}`), outcome: t(`judgeCheckOutcome_${c.outcome ?? 'needs_review'}`) })}
                </span>
                {c.providerError ? <span className="u-text-muted">{t('judgeCheckProviderDetail', { detail: providerDetail(c.providerError) })}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
