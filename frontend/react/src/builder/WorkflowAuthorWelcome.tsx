/**
 * Empty-state for the builder's "Create with AI" embedded chat (ADR 0073) —
 * context-aware to *authoring a workflow*, not the main chat's run/agents pitch
 * (that `WelcomeCard` stays gated to the chat page). It explains how AI authoring
 * works (describe → the Workflow Architect assembles a workflow from the nodes
 * this host supports → review it on the canvas), then offers example intents that
 * seed the composer. The conversation is already scoped to the Workflow Architect
 * agent (its system prompt drives the turn), so the examples are plain intents,
 * not slash commands. Reuses the shared `welcome-*` layout classes; token-only.
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SparklesIcon, ZapIcon, CheckIcon, FileTextIcon } from '../ui/icons/index.js';

const EXAMPLES = [
  { key: 'lead', Glyph: ZapIcon, titleKey: 'aiExLeadTitle', textKey: 'aiExLeadText' },
  { key: 'invoice', Glyph: CheckIcon, titleKey: 'aiExInvoiceTitle', textKey: 'aiExInvoiceText' },
  { key: 'doc', Glyph: FileTextIcon, titleKey: 'aiExDocTitle', textKey: 'aiExDocText' },
] as const;

export function WorkflowAuthorWelcome({ onPick, seedPrompt }: { onPick: (text: string) => void; seedPrompt?: string }): JSX.Element {
  const { t } = useTranslation('builder');
  // ADR 0137 — an accepted Ambient Work Graph suggestion seeds the Architect: auto-submit
  // the synthesized pattern ONCE so "Make a workflow" actually carries the work across.
  const sentRef = useRef(false);
  useEffect(() => {
    if (seedPrompt && !sentRef.current) { sentRef.current = true; onPick(seedPrompt); }
  }, [seedPrompt, onPick]);
  return (
    <div className="welcome-root">
      <div className="welcome-icon-circle" aria-hidden><SparklesIcon size={22} /></div>
      {/* h4: sits below the panel's h3 heading — `welcome-title` is presentational. */}
      <h4 className="welcome-title">{t('aiWelcomeTitle')}</h4>
      <p className="muted welcome-lede">{t('aiWelcomeBody')}</p>
      <div className="welcome-agents-label">{t('aiWelcomeExamplesLabel')}</div>
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
      <p className="muted welcome-footnote">{t('aiWelcomeFootnote')}</p>
    </div>
  );
}
