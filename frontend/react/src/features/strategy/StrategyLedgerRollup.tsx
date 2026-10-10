/**
 * ADR 0852 D4 — a strategy's roll-up of its projects' team ledgers.
 *
 * Nothing runs ON a strategy or an initiative, so neither has a ledger of its
 * own; the projects they point at do. This lists, read-only, the ledger of every
 * project linked to the strategy or to one of its initiatives: current version,
 * goal, open questions, changes waiting for the owner — each linking to the
 * project's Ledger tab, where the work on it happens.
 *
 * Caller-scoped by the summaries route: a project the viewer cannot read is
 * simply absent. Renders nothing when the ledger toggle is off or no project is
 * linked. A failed read is said.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { InlineState } from '../../ui/InlineState.js';
import { getLedgerSummaries, type LedgerSummary } from '../projects/teamLedgerClient.js';

const MAX = 20; // the summaries route's cap

export function StrategyLedgerRollup({ projectIds }: { projectIds: readonly string[] }): JSX.Element | null {
  const { t } = useTranslation('strategy');
  const key = [...new Set(projectIds)].slice(0, MAX).join(',');
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; summaries: LedgerSummary[] }>({ kind: 'loading' });

  useEffect(() => {
    if (!key) return;
    let live = true;
    setState({ kind: 'loading' });
    getLedgerSummaries(key.split(','))
      .then((summaries) => { if (live) setState({ kind: 'ready', summaries }); })
      .catch(() => { if (live) setState({ kind: 'failed' }); });
    return () => { live = false; };
  }, [key]);

  if (!key) return null;
  return (
    <section className="surface-card" aria-labelledby="strategy-ledgers">
      <h3 id="strategy-ledgers" className="u-mt-0 u-fs-14">{t('ledgerRollupTitle')}</h3>
      <p className="muted u-fs-12 u-mt-0">{t('ledgerRollupLede')}</p>
      {state.kind === 'loading' ? <InlineState kind="loading" message={t('ledgerRollupLoading')} /> : null}
      {state.kind === 'failed' ? <InlineState kind="failed" announce={t('ledgerRollupFailed')} announcePolite message={t('ledgerRollupFailed')} /> : null}
      {state.kind === 'ready' ? (
        state.summaries.length === 0 ? <p className="muted u-fs-12">{t('ledgerRollupNone')}</p> : (
          <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-2">
            {state.summaries.map((s) => (
              <li key={s.projectId}>
                <Link to={`/projects/${encodeURIComponent(s.projectId)}?tab=ledger`} className="u-fw-600">{s.name}</Link>
                {s.hasLedger ? (
                  <>
                    <span className="muted u-fs-12"> · {t('ledgerRollupVersion', { version: s.version })} · {t('ledgerRollupOpenQuestions', { count: s.openQuestionCount ?? 0 })}{s.pending ? ` · ${t('ledgerRollupPending', { count: s.pending })}` : ''}</span>
                    {s.goal ? <div className="u-fs-12">{s.goal}</div> : null}
                  </>
                ) : <span className="muted u-fs-12"> · {t('ledgerRollupNoLedger')}</span>}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
