/**
 * ADR 1005 D1 — the ONE reading of the `agents.deployment` advertisement, shared
 * by discovery, the routes and the channel resolver so they cannot disagree.
 * Presence is the claim: the v2 facet is closed and has no `supported` member.
 */

import { agentDeploymentEnabled } from '../../host/agentDeploymentFlag.js';
import { DEPLOYMENT_STATES, type DeploymentState } from './types.js';

export interface AgentDeploymentFacet {
  channels: string[];
  canary: true;
  rollback: true;
  states: DeploymentState[];
}

/** Channels a promote may bind. `latest` is resolved, never bound. */
export const BINDABLE_CHANNELS = ['stable', 'canary'] as const;
export const LATEST_CHANNEL = 'latest';

export function agentDeploymentFacet(): AgentDeploymentFacet | null {
  if (!agentDeploymentEnabled()) return null;
  return { channels: [...BINDABLE_CHANNELS, LATEST_CHANNEL], canary: true, rollback: true, states: [...DEPLOYMENT_STATES] };
}
