/**
 * Empty-state for the Studio's embedded Challenge Author chat (ADR 0461 P2) —
 * context-aware to *authoring a challenge*, mirroring the builder's
 * `WorkflowAuthorWelcome` (ADR 0073 pattern). It explains the conversational
 * intake (topic → audience → transformation → the factory runs with in-chat
 * checkpoints), offers example intents that seed the composer, and lists the
 * agent's ASSIGNED workflow portfolio — the roster truth served by the
 * `/creator/author` read, never a hand-painted list. The conversation is
 * already scoped to the Challenge Author, so examples are plain intents.
 * Reuses the shared `welcome-*` layout classes; token-only.
 */
import { useTranslation } from 'react-i18next';
import { WandIcon, BookOpenIcon, HeartIcon, ZapIcon, WorkflowIcon } from '../../ui/icons/index.js';
import type { AuthorWorkflow } from '../../client/kicktodoStudioClient.js';

const EXAMPLES = [
  { key: 'reading', Glyph: BookOpenIcon, titleKey: 'authorExReadingTitle', textKey: 'authorExReadingText' },
  { key: 'movement', Glyph: ZapIcon, titleKey: 'authorExMovementTitle', textKey: 'authorExMovementText' },
  { key: 'gratitude', Glyph: HeartIcon, titleKey: 'authorExGratitudeTitle', textKey: 'authorExGratitudeText' },
] as const;

/** KTUX-9 rule — literal keys per KNOWN workflow id so `check-i18n` sees them;
 *  an unknown id falls back to the raw id (honest, never a wrong label). */
function workflowTitle(workflowId: string, t: (k: string) => string): string {
  switch (workflowId) {
    case 'openwop-app.kicktodo.challenge-factory': return t('wfChallengeFactoryTitle');
    default: return workflowId;
  }
}
function workflowDesc(workflowId: string, t: (k: string) => string): string | null {
  switch (workflowId) {
    case 'openwop-app.kicktodo.challenge-factory': return t('wfChallengeFactoryDesc');
    default: return null;
  }
}

export function ChallengeAuthorWelcome({ onPick, workflows, autonomyLevel }: {
  onPick: (text: string) => void;
  workflows: AuthorWorkflow[];
  autonomyLevel?: string;
}): JSX.Element {
  const { t } = useTranslation('kicktodo-studio');
  return (
    <div className="welcome-root">
      <div className="welcome-icon-circle" aria-hidden><WandIcon size={22} /></div>
      {/* h3: one level below the intake section's h2 (no heading skip —
          `welcome-title` is presentational, the element carries the outline). */}
      <h3 className="welcome-title">{t('authorWelcomeTitle')}</h3>
      <p className="muted welcome-lede">{t('authorWelcomeBody')}</p>
      {/* ADR 0461 OQ1 — the autonomy trust cue: ALL KNOWN roster levels map
          to literal localized copy (KTUX-9; RES-3 — the cue must not vanish
          exactly when the agent gains autonomy); an unknown value renders
          NOTHING rather than a raw enum. */}
      {autonomyLevel === 'review' && (
        <span className="chip chip--muted">{t('autonomyReviewCue')}</span>
      )}
      {autonomyLevel === 'guided' && (
        <span className="chip chip--muted">{t('autonomyGuidedCue')}</span>
      )}
      {autonomyLevel === 'auto' && (
        <span className="chip chip--muted">{t('autonomyAutoCue')}</span>
      )}
      <div className="welcome-agents-label">{t('authorExamplesLabel')}</div>
      <div className="welcome-grid">
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
      {/* The agent's workflow portfolio — the roster truth (ADR 0461). Omitted
          entirely when the read failed; a workflow the catalog can't resolve is
          disclosed as unavailable, never hidden. */}
      {workflows.length > 0 && (
        <>
          <div className="welcome-agents-label">{t('authorWorkflowsLabel')}</div>
          <ul role="list" className="welcome-workflows">
            {workflows.map((w) => {
              const desc = workflowDesc(w.workflowId, t);
              return (
                <li key={w.workflowId} className="welcome-workflow-row">
                  <span className="welcome-card-icon" aria-hidden><WorkflowIcon size={16} /></span>
                  <span className="welcome-workflow-body">
                    <span className="welcome-card-title">{workflowTitle(w.workflowId, t)}</span>
                    {desc && <span className="welcome-card-desc">{desc}</span>}
                  </span>
                  {w.available
                    ? <span className="chip chip--muted">{t('workflowStages', { count: w.nodeCount })}</span>
                    : <span className="chip chip--muted">{t('workflowUnavailable')}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="muted welcome-footnote">{t('authorWelcomeFootnote')}</p>
    </div>
  );
}
