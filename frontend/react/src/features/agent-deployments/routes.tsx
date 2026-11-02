import { lazy } from 'react';
import type { FrontendFeature } from '../registry.js';

const AgentDeploymentsPanel = lazy(() => import('./AgentDeploymentsPanel.js').then((m) => ({ default: m.AgentDeploymentsPanel })));

/** ADR 1005 P3c / ADR 1014 P4b — the agent workspace's Deployments tab. Shown only
 *  where this host serves `agents.deployment` (the list answers 404 otherwise); the
 *  workspace page probes that, so this descriptor, which ships in the entry chunk,
 *  carries no client. */
export const agentDeploymentsFeature: FrontendFeature = {
  id: 'agent-deployments',
  routes: [],
  agentWorkspaceTabs: [{
    key: 'deployments',
    labelKey: 'wsTabDeployments',
    render: (p) => <AgentDeploymentsPanel {...p} />,
  }],
};
