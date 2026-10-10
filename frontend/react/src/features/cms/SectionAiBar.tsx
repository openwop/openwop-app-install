/**
 * AI actions on the selected section (ADR 0828 phase 3): improve, shorten,
 * expand, change the tone, fix spelling, or follow a short instruction. The
 * result is a PROPOSAL shown field by field, current beside proposed; nothing
 * changes until the person applies it, and Undo takes an applied rewrite back.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { SparklesIcon } from '../../ui/icons/index.js';
import { diffSections } from './sectionDiff.js';
import { rewriteSection, type RewriteAction, type Section } from './cmsClient.js';

const QUICK: Exclude<RewriteAction, 'custom'>[] = ['improve', 'shorten', 'expand', 'friendlier', 'formal', 'fix'];

export function SectionAiBar({ orgId, section, onApply, errorMessage }: {
  orgId: string;
  section: Section;
  onApply: (data: Record<string, unknown>) => void;
  /** Maps a failed call to the message the person sees. */
  errorMessage: (e: unknown) => string;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const [busy, setBusy] = useState<RewriteAction | null>(null);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: RewriteAction): Promise<void> => {
    setBusy(action); setError(null); setProposal(null);
    try {
      const data = await rewriteSection(orgId, { sectionType: section.type, data: section.data, action, ...(action === 'custom' ? { instruction: instruction.trim() } : {}) });
      setProposal(data);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const changes = proposal
    ? (diffSections([section], [{ ...section, data: proposal }])[0]?.fields ?? [])
    : [];

  return (
    <section className="cms-ai" aria-labelledby="cms-ai-heading" aria-busy={busy !== null}>
      <h3 id="cms-ai-heading" className="cms-ai-heading"><SparklesIcon size={14} /> {t('aiHeading')}</h3>
      <div className="u-flex u-gap-1 u-wrap">
        {QUICK.map((a) => (
          <Button key={a} variant="secondary" size="sm" disabled={busy !== null} aria-busy={busy === a} onClick={() => void run(a)}>
            {busy === a ? t('aiWorking') : t(`aiAction_${a}`)}
          </Button>
        ))}
      </div>
      <form className="cms-ai-ask" onSubmit={(e) => { e.preventDefault(); if (instruction.trim()) void run('custom'); }}>
        <input
          value={instruction}
          maxLength={500}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={t('aiAskPlaceholder')}
          aria-label={t('aiAskLabel')}
        />
        <Button type="submit" variant="secondary" size="sm" disabled={busy !== null || !instruction.trim()} aria-busy={busy === 'custom'}>
          {busy === 'custom' ? t('aiWorking') : t('aiAsk')}
        </Button>
      </form>
      {error ? <p className="u-label-sm u-m-0" role="alert">{error}</p> : null}
      {proposal ? (
        <div className="cms-ai-proposal" role="region" aria-label={t('aiProposalLabel')}>
          {changes.length === 0 ? (
            <p className="u-label-sm u-m-0">{t('aiNoChange')}</p>
          ) : changes.map((f) => (
            <div key={f.key} className="u-grid u-gap-1">
              <span className="u-label-sm">{f.key}</span>
              <div className="cms-diff-cols">
                <div className="cms-diff-col"><span className="u-label-sm">{t('aiCurrent')}</span><span className="cms-diff-text">{f.from || t('diffEmptyValue')}</span></div>
                <div className="cms-diff-col" data-side="version"><span className="u-label-sm">{t('aiProposed')}</span><span className="cms-diff-text">{f.to || t('diffEmptyValue')}</span></div>
              </div>
            </div>
          ))}
          <div className="action-bar">
            <span className="u-label-sm u-flex-1">{t('aiReviewHint')}</span>
            <Button variant="quiet" size="sm" onClick={() => setProposal(null)}>{t('aiDiscard')}</Button>
            {changes.length > 0 ? (
              <Button variant="primary" size="sm" onClick={() => { onApply(proposal); setProposal(null); }}>{t('aiApply')}</Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
