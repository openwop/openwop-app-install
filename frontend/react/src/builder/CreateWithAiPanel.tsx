/**
 * "Create with AI" panel (ADR 0073 Phase 3) — the builder's entry into AI
 * workflow authoring. It does NOT implement a chat or a BYOK gate: it owns only
 * the builder's drawer chrome (heading + Close) and delegates the AI surface to
 * the shared <EmbeddedChatPanel> (chat/), supplying its agent + a context-aware
 * empty state. The Workflow Architect authors + registers the workflow via its
 * node pack; the user opens the result on the canvas via load-by-id.
 *
 * EmbeddedChatPanel is **lazy-imported** from `chat/` so the builder doesn't add
 * a static import edge into chat/ (chat/ already imports builder/ — a static
 * builder→chat edge would create a cycle; the dynamic import is a separate chunk).
 * Features that `chat/` does NOT import back may static-import EmbeddedChatPanel.
 *
 * @see docs/adr/0073-embeddable-conversation-view.md
 */

import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkflowAuthorWelcome } from './WorkflowAuthorWelcome.js';

const EmbeddedChatPanel = lazy(() =>
  import('../chat/EmbeddedChatPanel.js').then((m) => ({ default: m.EmbeddedChatPanel })),
);

/** The agent the builder's "Create with AI" scopes the chat to (ADR 0072 pack). */
const WORKFLOW_ARCHITECT_AGENT_ID = 'feature.workflow-author.agents.workflow-architect';

/** A `seedPrompt` (ADR 0137 — from an accepted Ambient Work Graph suggestion) kicks the
 *  Workflow Architect with the recurring pattern: the empty state auto-submits it ONCE so
 *  the handoff actually carries the work across (no more no-op accept). Absent ⇒ the
 *  normal welcome. */
export function CreateWithAiPanel({ onClose, seedPrompt }: { onClose(): void; seedPrompt?: string }): JSX.Element {
  const { t } = useTranslation('builder');

  return (
    <div className="builder-ai-panel surface-card u-flex u-flex-col u-minh-0" role="region" aria-label={t('aiPanelHeading')}>
      <div className="u-flex u-items-center u-justify-between u-gap-2">
        <h3 className="u-m-0">{t('aiPanelHeading')}</h3>
        <button type="button" className="secondary btn-sm" onClick={onClose}>{t('aiClose')}</button>
      </div>
      <p className="muted u-fs-13 u-m-0">{t('aiPanelHint')}</p>
      <Suspense fallback={<div className="muted u-fs-13 u-p-3">{t('aiAuthoring')}</div>}>
        <EmbeddedChatPanel
          agentId={WORKFLOW_ARCHITECT_AGENT_ID}
          renderEmptyState={(onPick) => <WorkflowAuthorWelcome onPick={onPick} {...(seedPrompt ? { seedPrompt } : {})} />}
        />
      </Suspense>
    </div>
  );
}
