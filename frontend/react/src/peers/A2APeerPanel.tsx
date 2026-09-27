/**
 * A2APeerPanel — the honest not-yet-available state for A2A peer discovery,
 * paired with `McpToolsPanel` on `/capabilities`.
 *
 * ADR 0196 re-grade (ADM-2/DEMO-12): this panel previously rendered internal
 * spec/handoff document paths (`spec/v1/a2a-integration.md`,
 * `docs/myndhyve-round-2-handoff.md`) and vendor pack ids as USER-FACING copy
 * — contributor context that reads as another vendor's internals on an
 * enterprise install. That context lives HERE, in the comment, for
 * contributors only:
 *
 *   - `spec/v1/a2a-integration.md` (FINAL v1.1) documents the composition;
 *     the capability-advertisement shape is still a candidate
 *     (`{supported, agentCardUrl}`) and `capabilities.schema.json` defines no
 *     `capabilities.a2a` block yet.
 *   - The reference host does not expose itself as an A2A agent; no
 *     `core.a2a.*` NodeModule is registered.
 *   - `docs/myndhyve-round-2-handoff.md` §3 asks a non-steward host to
 *     publish an AgentCard, which would convert this into a real peer
 *     browser (Card fetch → Skills list → dispatch-node CTA).
 */

import { useTranslation } from 'react-i18next';
import { StateCard } from '../ui/StateCard.js';

export function A2APeerPanel() {
  const { t } = useTranslation('peers');
  return (
    <div className="surface-card">
      <h2>{t('title')}</h2>
      <StateCard title={t('notAvailableTitle')} body={t('notAvailableBody')} />
    </div>
  );
}
