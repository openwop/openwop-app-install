/**
 * Empty-state for the Guide's embedded KickBot chat (ADR 0442 Guide wave / ADR
 * 0073 pattern) — mirrors the Studio's `ChallengeAuthorWelcome`. It orients the
 * participant to a COACHING conversation (KickBot can see their plan, progress,
 * streaks, notes, leaderboard standing, circles, and coach proposals — the ADR
 * 0442 grounding reads) and offers example intents that seed the composer. The
 * two CONTEXTUAL seeds — today's next action and a pending coach proposal — come
 * from the live reads the page already made, so the first message can be about
 * what's actually in front of them. Reuses the shared `welcome-*` layout classes;
 * token-only.
 */
import { useTranslation } from 'react-i18next';
import { SparklesIcon, ZapIcon, HeartIcon } from '../../ui/icons/index.js';

const EXAMPLES = [
  { key: 'plan', Glyph: SparklesIcon, titleKey: 'guideExPlanTitle', textKey: 'guideExPlanText' },
  { key: 'progress', Glyph: ZapIcon, titleKey: 'guideExProgressTitle', textKey: 'guideExProgressText' },
  { key: 'stuck', Glyph: HeartIcon, titleKey: 'guideExStuckTitle', textKey: 'guideExStuckText' },
] as const;

export function GuideWelcome({ onPick, nextActionTitle, pendingProposals }: {
  onPick: (text: string) => void;
  nextActionTitle?: string | undefined;
  /** KT-G2 — null = could not check (distinct from 0 = nothing pending). */
  pendingProposals: number | null;
}): JSX.Element {
  const { t } = useTranslation('kicktodo');
  return (
    <div className="welcome-root">
      <div className="welcome-icon-circle" aria-hidden><SparklesIcon size={22} /></div>
      {/* h3: one level below the section's h2 (no heading skip). */}
      <h3 className="welcome-title">{t('guideChatWelcomeTitle')}</h3>
      <p className="muted welcome-lede">{t('guideChatWelcomeBody')}</p>
      {/* KickBot is autonomy 'review' by construction — the trust cue mirrors
          the Studio welcome's, always present (it proposes; you decide). */}
      <span className="chip chip--muted">{t('guideChatAutonomyCue')}</span>
      <div className="welcome-agents-label">{t('guideChatExamplesLabel')}</div>
      <div className="welcome-grid">
        {/* Contextual seeds first (only when the live reads surfaced them) — so
            the first thing offered is what is actually in front of the user. */}
        {nextActionTitle && (
          <button type="button" className="welcome-card" onClick={() => onPick(t('guideExTodayText', { title: nextActionTitle }))}>
            <span className="welcome-card-head">
              <span className="welcome-card-icon" aria-hidden><SparklesIcon size={16} /></span>
              <span className="welcome-card-title">{t('guideExTodayTitle')}</span>
            </span>
            <span className="welcome-card-desc">{t('guideExTodayText', { title: nextActionTitle })}</span>
          </button>
        )}
        {pendingProposals !== null && pendingProposals > 0 && (
          <button type="button" className="welcome-card" onClick={() => onPick(t('guideExProposalText'))}>
            <span className="welcome-card-head">
              <span className="welcome-card-icon" aria-hidden><HeartIcon size={16} /></span>
              <span className="welcome-card-title">{t('guideExProposalTitle')}</span>
            </span>
            <span className="welcome-card-desc">{t('guideExProposalText')}</span>
          </button>
        )}
        {EXAMPLES.map(({ key, Glyph, titleKey, textKey }) => (
          <button key={key} type="button" className="welcome-card" onClick={() => onPick(t(textKey))}>
            <span className="welcome-card-head">
              <span className="welcome-card-icon" aria-hidden><Glyph size={16} /></span>
              <span className="welcome-card-title">{t(titleKey)}</span>
            </span>
            <span className="welcome-card-desc">{t(textKey)}</span>
          </button>
        ))}
      </div>
      <p className="muted welcome-footnote">{t('guideChatFootnote')}</p>
    </div>
  );
}
