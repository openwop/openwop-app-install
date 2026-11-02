/**
 * ADR 1005 D1 — the RFC 0082 `agents.deployment` facet is served only when the
 * operator switches it on. Its own module so authorization and discovery can read
 * it without importing the executor seam (`agentChannelPin.ts`).
 */
export function agentDeploymentEnabled(): boolean {
  return process.env.OPENWOP_AGENT_DEPLOYMENT === 'on';
}
