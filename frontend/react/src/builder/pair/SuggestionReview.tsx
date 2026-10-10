/**
 * ADR 0773 D5 — the review card for the conversation's active suggestion: one
 * row per op with its live status, keep/drop per op, keep-all / drop, share
 * with the room (D7), and the opt-in auto-keep preference.
 *
 * Status is computed against the LIVE canvas on every render (`liveOpStatuses`),
 * so an op a peer's edit made stale says so before the user tries to keep it.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import { announce } from '../../ui/announce.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { useBuilderStore } from '../store/builderStore.js';
import { isValueOp, liveOpStatuses, type LiveOpStatus } from './suggestionModel.js';
import { usePairStore } from './pairStore.js';
import { opSummary } from './opSummary.js';

const STATUS_KEY: Record<LiveOpStatus, string> = {
  pending: 'pairOpPending', kept: 'pairOpKept', dropped: 'pairOpDropped', superseded: 'pairOpSuperseded',
  stale: 'pairOpStale', inapplicable: 'pairOpInapplicable',
};

export function SuggestionReview(): JSX.Element | null {
  const { t } = useTranslation('builder');
  const suggestion = usePairStore((s) => s.suggestion);
  const opState = usePairStore((s) => s.opState);
  const focusedOp = usePairStore((s) => s.focusedOp);
  const autoKeep = usePairStore((s) => s.autoKeep);
  const diagnoseNodeId = usePairStore((s) => s.diagnoseNodeId);
  const landing = usePairStore((s) => s.landing);
  const workflowId = useBuilderStore((s) => s.workflowId);
  const nodes = useBuilderStore((s) => s.nodes);
  const edges = useBuilderStore((s) => s.edges);
  const statuses = useMemo(
    () => (suggestion ? liveOpStatuses(suggestion, { nodes, edges }, opState) : []),
    [suggestion, nodes, edges, opState],
  );
  if (!suggestion || suggestion.workflowId !== workflowId || suggestion.ops.length === 0) return null;
  const pending = statuses.filter((s) => s === 'pending').length;
  const staleCount = statuses.filter((s) => s === 'stale').length;
  const store = usePairStore.getState;

  const keep = (indexes: number[]): void => {
    const r = store().keep(indexes);
    announce(r.skipped.length > 0
      ? t('pairAnnKeptSkipped', { kept: r.kept.length, skipped: r.skipped.length })
      : t('pairAnnKept', { count: r.kept.length }));
  };

  return (
    <section className="pair-review surface-card" aria-label={t('pairReviewAria')}>
      <header className="pair-review__head">
        <strong>{t('pairReviewTitle', { count: suggestion.ops.length })}</strong>
        <span className="u-mono u-fs-11 muted">{t('pairReviewPending', { count: pending })}</span>
      </header>
      {suggestion.summary ? <p className="pair-review__summary u-fs-13">{suggestion.summary}</p> : null}
      {/* P11 — is this still about the sheet as it is? Derived from the same
          per-change check the keep path uses, never from the revision number
          alone (a keep moves the revision without making anything stale). */}
      <p className={`pair-review__fresh u-fs-12${staleCount > 0 ? ' is-stale' : ''}`}>
        {staleCount > 0 ? t('pairFreshStale', { count: staleCount }) : t('pairFreshCurrent')}
      </p>
      <ol className="pair-review__ops">
        {suggestion.ops.map((o, i) => {
          const st = statuses[i] ?? 'pending';
          return (
            <li key={i} className={`pair-op pair-op--${st}${focusedOp === i ? ' is-focused' : ''}${landing.includes(i) ? ' is-landing' : ''}`}>
              <Button variant="quiet" size="sm" className="pair-op__focus" onClick={() => store().focusOp(i)} aria-current={focusedOp === i ? 'true' : undefined}>
                <span className="pair-op__num" aria-hidden>{i + 1}</span>
                <span className="pair-op__summary">{opSummary(o, { ops: suggestion.ops, nodes })}</span>
              </Button>
              <span className="pair-op__meta">
                {o.gateSensitive ? (
                  <span className="pair-op__gate" title={t('pairOpGateTitle')}><ShieldIcon size={12} aria-hidden />{t('pairOpGate')}</span>
                ) : null}
                <span className={`chip pair-op__status pair-op__status--${st}`}>{t(STATUS_KEY[st])}</span>
              </span>
              {o.why ? <p className="pair-op__why u-fs-12">{o.why}</p> : null}
              {st === 'dropped' ? (
                <span className="pair-op__actions">
                  <Button size="sm" variant="quiet" onClick={() => store().restore([i])}>{t('pairRestore')}</Button>
                </span>
              ) : null}
              {st === 'pending' ? (
                <span className="pair-op__actions">
                  <Button size="sm" variant="quiet" onClick={() => store().drop([i])} aria-label={t('pairDropOpAria', { n: i + 1 })}>{t('pairDrop')}</Button>
                  <Button size="sm" variant="accent" onClick={() => keep([i])} aria-label={t('pairKeepOpAria', { n: i + 1 })}>{t('pairKeep')}</Button>
                </span>
              ) : null}
              {st === 'stale' ? (
                <span className="pair-op__actions">
                  <Button size="sm" variant="quiet" onClick={() => store().drop([i])}>{t('pairKeepTheirs')}</Button>
                  <Button size="sm" variant="secondary" onClick={() => store().ask(t('pairRedoPrompt', { n: i + 1, summary: opSummary(o, { ops: suggestion.ops, nodes }) }))}>{t('pairAskRedo')}</Button>
                  {isValueOp(o.op) ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => {
                        void confirm({ title: t('pairUseAiConfirmTitle'), body: t('pairUseAiConfirmBody', { summary: opSummary(o, { ops: suggestion.ops, nodes }) }), confirmLabel: t('pairUseAi') })
                          .then((ok) => { if (ok) store().forceKeep(i); });
                      }}
                    >
                      {t('pairUseAi')}
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <footer className="pair-review__foot">
        <div className="pair-review__opts">
          <label className="pair-review__autokeep field-check-label u-fs-12">
            <input type="checkbox" checked={autoKeep} onChange={(e) => store().setAutoKeep(e.target.checked)} />
            {t('pairAutoKeep')}
          </label>
          <label className="pair-review__share field-check-label u-fs-12">
            <input type="checkbox" checked={suggestion.visibility === 'room'} onChange={(e) => { void store().share(e.target.checked); }} />
            {t('pairShareRoom')}
          </label>
        </div>
        <div className="pair-review__actions">
        {pending > 0 && diagnoseNodeId ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void store().keepAndRerun().then((r) => {
                if (r.ok) announce(t('pairRerunStarted'));
                else toast.error(r.reason === 'sync-failed' ? t('pairRerunNotSaved') : t('pairRerunFailed'));
              });
            }}
          >
            {t('pairKeepRerun')}
          </Button>
        ) : null}
        {pending > 0 ? (
          <>
            <Button size="sm" variant="quiet" onClick={() => store().dropAll()}>{t('pairDropAll')}</Button>
            <Button size="sm" variant="accent-solid" onClick={() => keep(suggestion.ops.map((_, i) => i).filter((i) => statuses[i] === 'pending'))}>{t('pairKeepAll')}</Button>
          </>
        ) : null}
        </div>
      </footer>
    </section>
  );
}
