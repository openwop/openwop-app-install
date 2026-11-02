/**
 * RFC 0082 deployment records (ADR 1005). The wire shape is
 * `schemas/v2/agent-deployment.schema.json`; `StoredDeployment` adds the host
 * fields the wire view strips (`wireView`).
 */

import { transitionRunIdOnWire } from './wire.js';

export const DEPLOYMENT_STATES = ['draft', 'test', 'staged', 'active', 'paused', 'deprecated', 'rolled-back'] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

export const DEPLOYMENT_TRANSITIONS = ['promote', 'pause', 'deprecate', 'rollback', 'adjust-canary'] as const;
export type DeploymentTransition = (typeof DEPLOYMENT_TRANSITIONS)[number];

/** `agent-deployment.schema.json`, closed. */
export interface DeploymentRecord {
  agentId: string;
  version: string;
  state: DeploymentState;
  canaryPercent?: number;
  rollbackPointer?: string;
  channels?: string[];
  evalRunId?: string;
  approvalGateId?: string;
  /** RFC 0254 §D — the deployment-management run of the last transition that changed this record. */
  transitionRunId?: string;
}

export interface StoredDeployment extends DeploymentRecord {
  tenant: string;
  /** Every write is a CAS on the row read; the counter makes each write distinct. */
  revision: number;
  /** Orders the actives on a channel: the newest takes its canary share. */
  activatedAt?: string;
  updatedAt: string;
}

/** `agent-deployment-transition.schema.json`, validated. */
export interface TransitionRequest {
  version: string;
  transition: DeploymentTransition;
  toState?: DeploymentState;
  channel?: string;
  canaryPercent?: number;
  evalRunId?: string;
  reason?: string;
}

export function wireView(r: StoredDeployment): DeploymentRecord {
  return {
    agentId: r.agentId,
    version: r.version,
    state: r.state,
    ...(r.canaryPercent !== undefined ? { canaryPercent: r.canaryPercent } : {}),
    ...(r.rollbackPointer !== undefined ? { rollbackPointer: r.rollbackPointer } : {}),
    ...(r.channels && r.channels.length > 0 ? { channels: [...r.channels] } : {}),
    ...(r.evalRunId !== undefined ? { evalRunId: r.evalRunId } : {}),
    ...(r.approvalGateId !== undefined ? { approvalGateId: r.approvalGateId } : {}),
    // Sent only once the pinned schemas seat it: the record is closed (wire.ts).
    ...(r.transitionRunId !== undefined && transitionRunIdOnWire() ? { transitionRunId: r.transitionRunId } : {}),
  };
}

/** Semver order where both parse, string order otherwise. */
export function compareVersions(a: string, b: string): number {
  // ADR 1014 P5 — user-agent revisions are bare integers: 10 follows 9.
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (pa && pb) {
    for (let i = 1; i <= 3; i++) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d !== 0) return d;
    }
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
