/**
 * Scenario builder (ADR 0235 §D1 / STRAT-FE2) — named what-if selections on a
 * planning session under maxItems/maxBudget constraints, resolved server-side
 * (above/below the line over intake estimated values), pairwise-comparable, and
 * one human-selected plan of record. Agent-PROPOSED scenarios are badged and
 * inert until a human selects — the structural-proposal posture.
 *
 * Strategy-coverage annotation ("this drop loses strategies X, Y") is
 * FE-COMPOSITION over the `strategyRefs` map the page already holds — the
 * compare endpoint deliberately returns idea movements only (the ADR 0079
 * import-direction rule; the PM feature never imports strategy).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { PlusIcon, FlagIcon, CheckIcon } from '../../ui/icons/index.js';
import { formatNumber } from '../../i18n/format.js';
import {
  listScenarios, addScenario, selectScenario, rejectScenario, compareScenarios,
  type ResolvedScenario,
} from './priorityMatrixClient.js';
import type { StrategyRefLite } from '../strategy/StrategyAlignment.js';

export function ScenarioPanel({ listId, sessionId, strategyRefs, onError }: {
  listId: string;
  sessionId: string;
  /** cardId → aligned strategies (for the FE-composition coverage overlay). */
  strategyRefs: Map<string, StrategyRefLite[]>;
  onError: (m: string) => void;
}): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const [scenarios, setScenarios] = useState<ResolvedScenario[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [topN, setTopN] = useState('5');
  const [maxItems, setMaxItems] = useState('');
  const [maxBudget, setMaxBudget] = useState('');
  const [cmpA, setCmpA] = useState('');
  const [cmpB, setCmpB] = useState('');
  const [cmp, setCmp] = useState<Awaited<ReturnType<typeof compareScenarios>> | null>(null);

  // Guard setState against a slow list resolving after the session switched or
  // the panel unmounted — an older listScenarios must not clobber a newer one
  // (grade-code FE#3; the session id changes when the open agenda changes).
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const refresh = useCallback(async () => {
    try { const rows = await listScenarios(listId, sessionId); if (mountedRef.current) setScenarios(rows); }
    catch (e) { if (mountedRef.current) onError(e instanceof Error ? e.message : t('scenarioLoadFailed')); }
  }, [listId, sessionId, onError, t]);
  useEffect(() => { void refresh(); }, [refresh]);
  // A session switch invalidates the compare selectors (they hold the old
  // session's scenario ids) and any shown result (FE#4).
  useEffect(() => { setCmp(null); setCmpA(''); setCmpB(''); }, [sessionId]);

  const add = async (): Promise<void> => {
    const n = Number(topN);
    if (!name.trim() || !Number.isInteger(n) || n < 1) { onError(t('scenarioNInvalid')); return; }
    // PMXU-9 (ADR 0590) — an invalid constraint is REFUSED loudly, never
    // silently dropped (the old branch created the scenario UNconstrained and
    // it read as if the constraint held — the fabrication family).
    const constraints: { maxItems?: number; maxBudget?: number } = {};
    if (maxItems.trim()) {
      const m = Number(maxItems);
      if (!Number.isInteger(m) || m <= 0) { onError(t('scenarioConstraintInvalid')); return; }
      constraints.maxItems = m;
    }
    if (maxBudget.trim()) {
      const b = Number(maxBudget);
      if (!Number.isFinite(b) || b <= 0) { onError(t('scenarioConstraintInvalid')); return; }
      constraints.maxBudget = b;
    }
    setBusy(true);
    try {
      await addScenario(listId, sessionId, { name: name.trim(), selection: { mode: 'top-n', n }, ...(Object.keys(constraints).length ? { constraints } : {}) });
      setName(''); setMaxItems(''); setMaxBudget('');
      setCmp(null); // the scenario set changed — a shown comparison is now stale (FE#4)
      await refresh();
    } catch (e) { onError(e instanceof Error ? e.message : t('scenarioAddFailed')); }
    finally { setBusy(false); }
  };

  const select = async (scenarioId: string): Promise<void> => {
    setBusy(true);
    try { await selectScenario(listId, sessionId, scenarioId); setCmp(null); await refresh(); }
    catch (e) { onError(e instanceof Error ? e.message : t('scenarioSelectFailed')); }
    finally { setBusy(false); }
  };

  // PMXU-2 (ADR 0590) — decline an agent proposal from the page (decides the
  // SHARED approval row; the reviews inbox converges on the same record).
  const rejectProposal = async (scenarioId: string): Promise<void> => {
    setBusy(true);
    try { await rejectScenario(listId, sessionId, scenarioId); setCmp(null); await refresh(); }
    catch (e) { onError(e instanceof Error ? e.message : t('scenarioRejectFailed')); }
    finally { setBusy(false); }
  };

  const runCompare = async (): Promise<void> => {
    if (!cmpA || !cmpB || cmpA === cmpB) return;
    setBusy(true);
    try { setCmp(await compareScenarios(listId, sessionId, cmpA, cmpB)); }
    catch (e) { onError(e instanceof Error ? e.message : t('scenarioCompareFailed')); }
    finally { setBusy(false); }
  };

  /** The strategies an idea is aligned to (the coverage a drop would lose). */
  const coverage = (cardId: string): string[] => (strategyRefs.get(cardId) ?? []).map((r) => r.title);

  return (
    <section className="card u-flex u-flex-col u-gap-3" aria-label={t('scenariosTitle')}>
      <div>
        <h3 className="u-m-0 u-fs-14">{t('scenariosTitle')}</h3>
        <p className="muted u-fs-12 u-m-0">{t('scenariosLede')}</p>
      </div>

      <div className="surface-form surface-card u-py-2">
        <TextField label={t('scenarioName')} value={name} onChange={(e) => setName(e.target.value)} className="u-flex-1" />
        <TextField label={t('scenarioTopN')} value={topN} onChange={(e) => setTopN(e.target.value)} inputMode="numeric" />
        <TextField label={t('scenarioMaxItems')} value={maxItems} onChange={(e) => setMaxItems(e.target.value)} inputMode="numeric" />
        <TextField label={t('scenarioMaxBudget')} value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} inputMode="decimal" />
        <Button variant="primary" size="sm" disabled={busy || !name.trim()} onClick={() => void add()}><PlusIcon size={13} /> {t('scenarioAdd')}</Button>
      </div>

      {scenarios === null ? (
        <p className="muted u-fs-12" role="status">{t('common:loading')}</p>
      ) : scenarios.length === 0 ? (
        <StateCard icon={<FlagIcon />} title={t('scenariosEmpty')} body={t('scenariosEmptyBody')} />
      ) : (
        <ul className="u-flex u-flex-col u-gap-2 u-list-none u-p-0 u-m-0">
          {scenarios.map((s) => (
            <li key={s.scenarioId} className="surface-card u-flex u-flex-col u-gap-2 u-py-2">
              <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
                <strong className="u-fs-13">{s.name}</strong>
                {s.planOfRecord ? <span className="chip chip--success u-fs-11"><CheckIcon size={11} aria-hidden /> {t('scenarioPlanOfRecord')}</span> : null}
                {/* PMXU-2 (ADR 0590) — a REJECTED agent proposal is a decided
                    state: badge it and stop offering "Set as plan of record"
                    (pre-fix it was byte-identical to an undecided one and the
                    dead-end was the raw core "Approval already rejected."). */}
                {s.approvalStatus === 'rejected' ? <span className="chip chip--danger u-fs-11">{t('scenarioRejected')}</span> : null}
                {s.proposedBy === 'agent' && s.approvalStatus !== 'rejected' ? <span className="chip chip--warning u-fs-11">{t('scenarioProposed')}</span> : null}
                <span className="chip chip--accent u-fs-11">{t('scenarioAbove', { count: s.aboveLine.length, formattedCount: formatNumber(s.aboveLine.length) })}</span>
                {s.belowLine.length > 0 ? <span className="chip chip--muted u-fs-11">{t('scenarioBelow', { count: s.belowLine.length, formattedCount: formatNumber(s.belowLine.length) })}</span> : null}
                {s.totalEstimatedValue > 0 ? <span className="chip chip--muted u-fs-11">{t('scenarioTotal', { value: formatNumber(s.totalEstimatedValue) })}</span> : null}
                {!s.planOfRecord && s.approvalStatus !== 'rejected' ? <Button variant="quiet" size="sm" className="u-ml-auto" disabled={busy} onClick={() => void select(s.scenarioId)}>{t('scenarioSelect')}</Button> : null}
                {s.proposedBy === 'agent' && s.approvalStatus === 'pending' ? <Button variant="quiet" size="sm" disabled={busy} onClick={() => void rejectProposal(s.scenarioId)}>{t('scenarioRejectAction')}</Button> : null}
              </div>
              {s.belowLine.length > 0 ? (
                <p className="muted u-fs-12 u-m-0">{t('scenarioDropped', { titles: s.belowLine.map((x) => x.title).join(', ') })}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {scenarios && scenarios.length >= 2 ? (
        <div className="u-flex u-flex-col u-gap-2 surface-card u-py-2">
          <div className="surface-form">
            <SelectField label={t('scenarioCompareA')} value={cmpA} onChange={(e) => { setCmpA(e.target.value); setCmp(null); }} className="u-flex-1">
              <option value="">{t('scenarioComparePick')}</option>
              {scenarios.map((s) => <option key={s.scenarioId} value={s.scenarioId}>{s.name}</option>)}
            </SelectField>
            <SelectField label={t('scenarioCompareB')} value={cmpB} onChange={(e) => { setCmpB(e.target.value); setCmp(null); }} className="u-flex-1">
              <option value="">{t('scenarioComparePick')}</option>
              {scenarios.map((s) => <option key={s.scenarioId} value={s.scenarioId}>{s.name}</option>)}
            </SelectField>
            <Button variant="quiet" size="sm" disabled={busy || !cmpA || !cmpB || cmpA === cmpB} onClick={() => void runCompare()}>{t('scenarioCompare')}</Button>
          </div>
          {cmp ? (
            <div className="u-flex u-flex-col u-gap-1">
              {cmp.gainedInB.length === 0 && cmp.droppedInB.length === 0 ? (
                <Notice variant="info">{t('scenarioCompareSame')}</Notice>
              ) : (
                <>
                  {cmp.droppedInB.map((x) => (
                    <p key={x.cardId} className="u-fs-12 u-m-0">
                      <span className="chip chip--danger u-fs-11">{t('scenarioMovesBelow')}</span> {x.title}
                      {coverage(x.cardId).length > 0 ? <span className="muted"> — {t('scenarioLosesCoverage', { strategies: coverage(x.cardId).join(', ') })}</span> : null}
                    </p>
                  ))}
                  {cmp.gainedInB.map((x) => (
                    <p key={x.cardId} className="u-fs-12 u-m-0"><span className="chip chip--success u-fs-11">{t('scenarioMovesAbove')}</span> {x.title}</p>
                  ))}
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
