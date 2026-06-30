/**
 * A2APeerPanel — placeholder for the A2A composition pairing with the
 * already-shipped `McpToolsPanel`.
 *
 * `spec/v1/a2a-integration.md` (FINAL v1.1, 2026-05-05) documents how
 * an openwop host can expose itself as an A2A agent (each Workflow →
 * an `AgentSkill`, each run → a `Task`) and how an openwop client can
 * dispatch into a remote A2A peer. But:
 *
 *   - the capability advertisement shape is still a candidate
 *     (`{supported: boolean, agentCardUrl: string}` is the leading
 *     candidate per `a2a-integration.md` §"Capability advertisement");
 *   - `capabilities.schema.json` does NOT yet define a `capabilities.a2a`
 *     block;
 *   - the reference host does NOT expose itself as an A2A agent and
 *     no `core.a2a.*` NodeModule is registered;
 *   - no non-steward host publishes an A2A AgentCard yet.
 *
 * So this panel does the only honest thing the reference app can do
 * today: tell the operator that A2A peer discovery is not yet
 * advertised, point at the spec, and point at the round-2 handoff
 * (`docs/myndhyve-round-2-handoff.md` §3) that asks MyndHyve to publish
 * an A2A peer endpoint — which would convert this panel from a
 * placeholder into a real peer browser.
 *
 * The MCP companion (`McpToolsPanel`) renders right above it on
 * `/capabilities`, so the operator sees the paired surface even
 * though one side is not yet implementable end-to-end.
 */

import { useTranslation } from 'react-i18next';

export function A2APeerPanel() {
  const { t } = useTranslation('peers');
  return (
    <div className="surface-card">
      <h2>
        {t('title')}{' '}
        <span className="muted u-fs-12 u-fw-400">
          (<code>spec/v1/a2a-integration.md</code>)
        </span>
      </h2>
      <p className="muted u-fs-13">
        {t('introLead')}{' '}
        <code>{t('introAgentSkill')}</code>{t('introMid')} <code>{t('introTask')}</code>{t('introTail')}{' '}
        <strong>{t('notAdvertised')}</strong>
      </p>
      <p className="muted u-fs-12">
        {t('statusLead')} <em>{t('statusStable')}</em> {t('statusMid1')}{' '}
        <code>spec/v1/a2a-integration.md</code> {t('statusMid2')}{' '}
        <code>{'{supported: true, agentCardUrl: "…"}'}</code>{t('statusMid3')}{' '}
        <code>capabilities.schema.json</code> {t('statusMid4')}{' '}
        <code>{t('statusBlock')}</code> {t('statusTail')} <code>core.a2a.*</code>{' '}
        {t('statusNodeModule')}
      </p>
      <p className="muted u-fs-12">
        {t('pathForwardLead')}{' '}
        <code>docs/myndhyve-round-2-handoff.md</code> {t('pathForwardMid')}{' '}
        <code>vendor.myndhyve.agent-orchestration</code>{' '}
        {t('pathForwardAnd')} <code>vendor.myndhyve.ads-crew</code>{t('pathForwardTail')}{' '}
        <code>{t('pathForwardShape')}</code> {t('pathForwardEnd')}{' '}
        <code>{t('pathForwardNode')}</code> {t('pathForwardCta')}
      </p>
    </div>
  );
}
