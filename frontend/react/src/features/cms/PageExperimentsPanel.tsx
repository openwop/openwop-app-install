/**
 * Page experiments panel (ADR 0236 — campaign gap D1). A lazy `<details>`
 * sibling of the History panel on the CMS editor: list + create an experiment
 * whose variants are the page's EXISTING captured versions (holdout = the live
 * published content), start/stop it, read the per-variant results (two-
 * proportion significance with honest small-sample flagging), and promote the
 * winner through the EXISTING restore→publish verbs (the backend reports
 * `pendingApproval` when the org gates publishing).
 */
import { Button } from '../../ui/Button.js';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatNumber, formatPercent } from '../../i18n/format.js';
import { confirm } from '../../ui/confirm.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { IconButton } from '../../ui/IconButton.js';
import { toast } from '../../ui/toast.js';
import { ActivityIcon, PlayIcon, PlusIcon, StopIcon, TrashIcon, XIcon } from '../../ui/icons/index.js';
import {
  createExperiment,
  deleteExperiment,
  experimentResults,
  listExperiments,
  promoteExperiment,
  startExperiment,
  stopExperiment,
  type ExperimentResults,
  type ExperimentStatus,
  type PageExperiment,
  type PageVersion,
} from './cmsClient.js';

/** Experiment status → §5.3 chip variant (the status word rides alongside). */
function expChipClass(status: ExperimentStatus): string {
  switch (status) {
    case 'running': return 'chip chip--success';
    case 'promoted': return 'chip chip--accent';
    case 'stopped': return 'chip chip--warning';
    default: return 'chip chip--muted'; // draft
  }
}

interface VariantDraft { key: string; versionId: string; weight: string }

const DEFAULT_DRAFT: VariantDraft[] = [
  { key: 'control', versionId: '', weight: '50' },
  { key: 'B', versionId: '', weight: '50' },
];

export function PageExperimentsPanel({ orgId, pageId, versions, onLoadVersions, onPageChanged }: {
  orgId: string;
  pageId: string;
  versions: PageVersion[] | null;
  onLoadVersions: () => void;
  onPageChanged: () => void;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const [experiments, setExperiments] = useState<PageExperiment[] | null>(null);
  const [results, setResults] = useState<Record<string, ExperimentResults>>({});
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<VariantDraft[]>(DEFAULT_DRAFT);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // CMPUX-18: per-action busy guard so a row's start/stop/results/promote/delete
  // button disables while its own request is in flight (the server already has
  // CAS from grade-code, so this is a UX guard against a confusing double-tap).
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const WEIGHT_SUM_ID = `${useId()}-weightsum`; // CMPUX-17: ties the weight inputs to the sum warning
  const runAction = async (key: string, fn: () => Promise<void>): Promise<void> => {
    if (pending.has(key)) return;
    setPending((p) => new Set(p).add(key));
    try { await fn(); }
    finally { setPending((p) => { const n = new Set(p); n.delete(key); return n; }); }
  };

  const reload = (): void => {
    // A load failure must NOT masquerade as "no experiments" (grade-ux): render
    // an error Notice, not the empty state.
    setLoadError(false);
    void listExperiments(orgId, pageId).then(setExperiments).catch(() => { setExperiments([]); setLoadError(true); });
  };

  const weightTotal = draft.reduce((s, v) => s + (Number.parseInt(v.weight, 10) || 0), 0);
  const keysOk = draft.every((v) => v.key.trim().length > 0) && new Set(draft.map((v) => v.key.trim())).size === draft.length;
  const nameOk = name.trim().length > 0;
  const canCreate = nameOk && weightTotal === 100 && keysOk && !busy;
  // Surface WHY Create is disabled (grade-ux): a silently-dead button is a
  // form-a11y anti-pattern. Weight-sum has its own Notice below; this covers
  // the name + variant-key reasons.
  const createBlockedReason = !nameOk ? t('expNeedsName') : !keysOk ? t('expNeedsKeys') : null;

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const exp = await createExperiment(orgId, pageId, {
        name: name.trim(),
        variants: draft.map((v) => ({ key: v.key.trim(), versionId: v.versionId || null, weight: Number.parseInt(v.weight, 10) || 0 })),
      });
      setExperiments((prev) => [exp, ...(prev ?? [])]);
      setName('');
      setDraft(DEFAULT_DRAFT);
      toast.success(t('expCreated'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('expCreateFailed')); }
    finally { setBusy(false); }
  };

  const replaceExp = (exp: PageExperiment): void => {
    setExperiments((prev) => (prev ?? []).map((x) => (x.experimentId === exp.experimentId ? exp : x)));
  };

  const start = async (exp: PageExperiment): Promise<void> => {
    try { replaceExp(await startExperiment(orgId, pageId, exp.experimentId)); toast.success(t('expStarted')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('expActionFailed')); }
  };
  const stop = async (exp: PageExperiment): Promise<void> => {
    try { replaceExp(await stopExperiment(orgId, pageId, exp.experimentId)); toast.success(t('expStopped')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('expActionFailed')); }
  };
  const remove = async (exp: PageExperiment): Promise<void> => {
    if (!(await confirm({ title: t('expDeleteConfirm', { name: exp.name }), body: t('common:cannotBeUndone'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteExperiment(orgId, pageId, exp.experimentId);
      setExperiments((prev) => (prev ?? []).filter((x) => x.experimentId !== exp.experimentId));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('expActionFailed')); }
  };
  const loadResults = async (exp: PageExperiment): Promise<void> => {
    try {
      const r = await experimentResults(orgId, pageId, exp.experimentId);
      setResults((prev) => ({ ...prev, [exp.experimentId]: r }));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('expActionFailed')); }
  };
  const promote = async (exp: PageExperiment, variantKey: string): Promise<void> => {
    if (!(await confirm({ title: t('expPromoteConfirmTitle', { key: variantKey }), body: t('expPromoteConfirmBody'), confirmLabel: t('expPromote') }))) return;
    try {
      const r = await promoteExperiment(orgId, pageId, exp.experimentId, variantKey);
      replaceExp(r.experiment);
      toast.success(r.pendingApproval ? t('expPromotedPending') : t('expPromoted'));
      onPageChanged(); // restore/publish changed the page — refresh the editor
    } catch (e) { toast.error(e instanceof Error ? e.message : t('expActionFailed')); }
  };

  const versionLabel = (versionId: string | null): string => {
    if (versionId === null) return t('expHoldoutOption');
    const v = (versions ?? []).find((x) => x.versionId === versionId);
    return v ? t('expVersionOption', { version: v.version, title: v.snapshot.title }) : versionId;
  };

  return (
    <details
      key={`exp-${pageId}`}
      className="surface-card u-gap-2"
      onToggle={(e) => {
        if (!(e.target as HTMLDetailsElement).open) return;
        if (experiments === null) reload();
        if (versions === null) onLoadVersions();
      }}
    >
      <summary className="u-label-sm"><ActivityIcon size={13} /> {t('expHeading')}</summary>
      <div className="u-grid u-gap-2 u-mt-2">
        <span className="u-label-sm">{t('expLede')}</span>

        {loadError ? (
          <Notice variant="error">{t('expLoadError')}</Notice>
        ) : null}
        {!experiments ? <Skeleton /> : experiments.length === 0 && !loadError ? (
          <span className="u-label-sm">{t('expEmpty')}</span>
        ) : experiments.map((exp) => {
          const r = results[exp.experimentId];
          return (
            <div key={exp.experimentId} className="u-grid u-gap-1">
              <div className="u-flex u-gap-2 u-items-center u-wrap">
                <span className={expChipClass(exp.status)}>{t(`expStatus_${exp.status}`)}</span>
                <span className="u-flex-1">{exp.name}</span>
                {exp.startedAt ? <span className="u-label-sm">{formatDateTime(exp.startedAt)}</span> : null}
                {exp.status === 'draft' || exp.status === 'stopped' ? (
                  <Button variant="quiet" className="u-w-auto" disabled={pending.has(`${exp.experimentId}:start`)} aria-busy={pending.has(`${exp.experimentId}:start`)} onClick={() => void runAction(`${exp.experimentId}:start`, () => start(exp))}><PlayIcon size={13} /> {t('expStart')}</Button>
                ) : null}
                {exp.status === 'running' ? (
                  <Button variant="quiet" className="u-w-auto" disabled={pending.has(`${exp.experimentId}:stop`)} aria-busy={pending.has(`${exp.experimentId}:stop`)} onClick={() => void runAction(`${exp.experimentId}:stop`, () => stop(exp))}><StopIcon size={13} /> {t('expStop')}</Button>
                ) : null}
                <Button variant="quiet" className="u-w-auto" disabled={pending.has(`${exp.experimentId}:results`)} aria-busy={pending.has(`${exp.experimentId}:results`)} onClick={() => void runAction(`${exp.experimentId}:results`, () => loadResults(exp))}>{t('expResultsShow')}</Button>
                {exp.status !== 'running' ? (
                  <IconButton label={t('expDeleteLabel', { name: exp.name })} icon={<TrashIcon />} className="btn-ghost" disabled={pending.has(`${exp.experimentId}:remove`)} onClick={() => void runAction(`${exp.experimentId}:remove`, () => remove(exp))} />
                ) : null}
              </div>
              {r ? (
                <div className="u-grid u-gap-1">
                  {r.unattributed && r.unattributed.legacy + r.unattributed.dropped > 0 ? (
                    <Notice variant="warning">{t('expUnattributedNotice', { legacy: formatNumber(r.unattributed.legacy), dropped: formatNumber(r.unattributed.dropped) })}</Notice>
                  ) : null}
                  {r.variants.some((v) => v.insufficientSample) ? (
                    <Notice variant="info">{t('expInsufficientNotice', { min: formatNumber(r.minSessionsPerVariant) })}</Notice>
                  ) : null}
                  {r.variants.map((v) => (
                    <div key={v.key} className="u-flex u-gap-2 u-items-center u-wrap">
                      <span className="chip chip--muted">{v.key}</span>
                      {v.versionId === null ? <span className="chip chip--muted">{t('expHoldoutChip')}</span> : null}
                      {v.key === r.baselineKey ? <span className="chip chip--muted">{t('expBaselineChip')}</span> : null}
                      <span className="u-label-sm">
                        {t('expResultsLine', {
                          sessions: formatNumber(v.sessions),
                          conversions: formatNumber(v.conversions),
                          rate: formatPercent(v.conversionRate, { maximumFractionDigits: 1 }),
                        })}
                        {v.zScore !== null ? ` · z ${formatNumber(v.zScore, { maximumFractionDigits: 2 })}` : ''}
                      </span>
                      {v.significant === true ? <span className="chip chip--success">{t('expSignificantChip')}</span> : null}
                      {v.significant === false ? <span className="chip chip--muted">{t('expNotSignificantChip')}</span> : null}
                      <span className="u-flex-1" />
                      <span className="u-label-sm">{versionLabel(v.versionId)}</span>
                      {exp.status === 'running' ? (
                        <Button variant="quiet" className="u-w-auto" disabled={pending.has(`${exp.experimentId}:promote:${v.key}`)} aria-busy={pending.has(`${exp.experimentId}:promote:${v.key}`)} onClick={() => void runAction(`${exp.experimentId}:promote:${v.key}`, () => promote(exp, v.key))}>{t('expPromote')}</Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}

        {/* Create — variants pick from the page's captured versions. */}
        {versions !== null && versions.length === 0 ? (
          <Notice variant="info">{t('expNeedsVersions')}</Notice>
        ) : (
          <div className="u-grid u-gap-1">
            <TextField label={t('expNameLabel')} value={name} placeholder={t('expNamePlaceholder')} onChange={(e) => setName(e.target.value)} />
            {draft.map((v, i) => (
              <div key={i} className="u-flex u-gap-1 u-items-end u-wrap">
                <TextField label={t('expVariantKeyLabel', { n: i + 1 })} value={v.key} className="u-w-auto u-mb-0"
                  onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                <SelectField label={t('expVariantVersionLabel', { n: i + 1 })} value={v.versionId} className="u-flex-1 u-mb-0"
                  onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, versionId: e.target.value } : x)))}>
                  <option value="">{t('expHoldoutOption')}</option>
                  {(versions ?? []).map((pv) => (
                    <option key={pv.versionId} value={pv.versionId}>{t('expVersionOption', { version: pv.version, title: pv.snapshot.title })}</option>
                  ))}
                </SelectField>
                <TextField label={t('expVariantWeightLabel', { n: i + 1 })} value={v.weight} type="number" min={1} max={100} className="u-w-auto u-mb-0"
                  aria-describedby={weightTotal !== 100 ? WEIGHT_SUM_ID : undefined}
                  onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)))} />
                {draft.length > 2 ? (
                  <IconButton label={t('expRemoveVariant', { key: v.key })} icon={<XIcon />} className="btn-ghost"
                    onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} />
                ) : null}
              </div>
            ))}
            {weightTotal !== 100 ? <Notice variant="warning" id={WEIGHT_SUM_ID}>{t('expWeightSum', { total: formatNumber(weightTotal) })}</Notice> : null}
            {weightTotal === 100 && createBlockedReason ? <Notice variant="info">{createBlockedReason}</Notice> : null}
            <div className="u-flex u-gap-1">
              {draft.length < 6 ? (
                <Button variant="quiet" className="u-w-auto"
                  onClick={() => setDraft((d) => [...d, { key: String.fromCharCode(65 + d.length), versionId: '', weight: '10' }])}>
                  <PlusIcon size={13} /> {t('expAddVariant')}
                </Button>
              ) : null}
              <span className="u-flex-1" />
              <Button variant="primary" className="u-w-auto" disabled={!canCreate} aria-busy={busy} onClick={() => void create()}>{t('expCreate')}</Button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
