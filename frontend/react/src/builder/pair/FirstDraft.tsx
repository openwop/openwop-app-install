/**
 * ADR 0773 D6 — never a blank sheet (DESIGN.md §7.1.11). On an EMPTY workflow
 * with pairing on, the sheet opens onto one composer: describe the workflow and
 * the Architect drafts it as a suggestion you review like any other. Phases come
 * from real tool events (`usePairStore.phase`), never a timer.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { usePairStore } from './pairStore.js';
import { listChainTemplates, type ChainTemplate } from '../persistence/backendStore.js';
import { toast } from '../../ui/toast.js';

const PHASES = ['thinking', 'reading', 'drafting', 'review'] as const;

export function FirstDraft(): JSX.Element {
  const { t } = useTranslation('builder');
  const [text, setText] = useState('');
  const phase = usePairStore((s) => s.phase);
  const busy = phase !== 'idle' && phase !== 'review';
  const placed = usePairStore((s) => s.suggestion?.ops.length ?? 0);
  const planned = usePairStore((s) => s.suggestion?.plannedOps);
  // G-05c — three templates that need NO inputs (one with required params would
  // draw blanks; those open from the gallery instead).
  const [chains, setChains] = useState<ChainTemplate[]>([]);
  useEffect(() => {
    let live = true;
    void listChainTemplates()
      .then((all) => { if (live) setChains(all.filter((c) => !(c.parameters?.required?.length)).slice(0, 3)); })
      .catch(() => { if (live) setChains([]); });
    return () => { live = false; };
  }, []);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    usePairStore.getState().ask(t('pairFirstDraftPrompt', { intent: v }));
  };

  return (
    <div className="pair-first-draft">
      <form className="pair-first-draft__card surface-card" onSubmit={submit} aria-label={t('pairFirstDraftAria')}>
        <h2 className="pair-first-draft__title">{t('pairFirstDraftTitle')}</h2>
        <label className="sr-only" htmlFor="pair-first-draft-input">{t('pairFirstDraftTitle')}</label>
        <textarea
          id="pair-first-draft-input"
          className="pair-first-draft__input"
          rows={3}
          value={text}
          placeholder={t('pairFirstDraftPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
        <div className="pair-first-draft__row">
          <span className="muted u-fs-12">{t('pairFirstDraftHint')}</span>
          <Button type="submit" variant="accent-solid" disabled={!text.trim() || busy} loading={busy}>{t('pairFirstDraftCta')}</Button>
        </div>
        {busy ? (
          <div className="pair-first-draft__progress">
            <ol className="pair-first-draft__phases" aria-label={t('pairPhasesAria')}>
              {PHASES.map((p) => {
                const at = PHASES.indexOf(phase as (typeof PHASES)[number]);
                const i = PHASES.indexOf(p);
                return <li key={p} className={i < at ? 'is-done' : i === at ? 'is-current' : ''} aria-current={i === at ? 'step' : undefined}>{t(`pairPhase_${p}`)}</li>;
              })}
            </ol>
            {/* G-05b — the running count from the appended suggestion. */}
            {phase === 'drafting' && placed > 0 ? (
              <span className="u-fs-12">{t('pairPlacing', { n: placed, total: Math.max(planned ?? placed, placed) })}</span>
            ) : null}
            {/* G-05e — stop the in-flight turn; ops already drawn stay reviewable. */}
            <Button size="sm" variant="secondary" onClick={() => usePairStore.getState().stop()}>{t('pairStop')}</Button>
          </div>
        ) : null}
        {chains.length > 0 && !busy ? (
          <div className="pair-first-draft__chains">
            <p className="muted u-fs-12 u-m-0">{t('pairFirstDraftChains')}</p>
            <div className="u-flex u-gap-2 u-wrap">
              {chains.map((c) => (
                <Button
                  key={c.chainId}
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void usePairStore.getState().suggestFromChain(c.chainId).then((r) => {
                      if (!r.ok) toast.error(t('pairChainFailed', { name: c.label }));
                    });
                  }}
                >
                  {c.label}
                  {/* P11 — the size of what will be drawn, before anyone clicks. */}
                  {typeof c.requirements?.nodeCount === 'number' ? (
                    <span className="pair-first-draft__chip-meta">
                      {' · '}{t('pairTemplateSteps', { count: c.requirements.nodeCount })}
                      {c.requirements.approvalGateCount ? <>{' · '}{t('pairTemplateGates', { count: c.requirements.approvalGateCount })}</> : null}
                    </span>
                  ) : null}
                </Button>
              ))}
              {/* P11 — every template, including those that need inputs first. */}
              <Link to="/builder" className="btn-ghost btn-sm">{t('pairTemplateBrowseAll')}</Link>
            </div>
          </div>
        ) : null}
        <p className="muted u-fs-12 u-m-0">{t('pairFirstDraftOrDrag')}</p>
      </form>
    </div>
  );
}
