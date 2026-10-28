/**
 * Campaign playbooks (ADR 0959) — an agency's campaign method, published once as a versioned
 * bundle of workflow chains and installed per client. A playbook is TENANT DATA in the existing
 * RFC 0013/0133 chain format (D1); it becomes a workflow only through an install, which goes
 * through the one chain-instantiation path (`host/chainInstantiation.ts`).
 */
import type { WorkflowChain } from '../../host/workflowChainPackLoader.js';

/** D3 — a client's (or the agency's) own chain bound to a declared slot: another playbook
 *  version of the SAME tenant, by exact version (immutable, so the binding cannot drift). */
export interface SlotBinding {
  playbookId: string;
  version: string;
  chainId: string;
}

/** A config layer: chain parameter values and slot bindings (D3). The ADR 0942 policy and
 *  ADR 0943 agent-binding pointers join this when those ADRs land. */
export interface ConfigLayer {
  params: Record<string, unknown>;
  slots?: Record<string, SlotBinding>;
}

/** Which keys a lower layer may override (D3): entry-chain parameter names and slot refs. */
export interface OverridePolicy {
  params: string[];
  slots: string[];
}

/** D3 — a structural customization point: a `subChainRef` of the entry chain a layer may rebind. */
export interface PlaybookSlot {
  ref: string;
  label: string;
}

/** D5 — one content item a playbook installs into each client org, through the owner's adapter. */
export interface PlaybookContentItem {
  slot: string;
  kind: string;
  payload: Record<string, unknown>;
}

/** The editable body a draft holds and a version freezes. */
export interface PlaybookBody {
  title: string;
  chains: WorkflowChain[];
  entryChainId: string;
  defaults: ConfigLayer;
  overridable: OverridePolicy;
  slots: PlaybookSlot[];
  /** D5 — absent on versions published before P4 (treated as none). */
  content?: PlaybookContentItem[];
  changelog: string;
}

export interface PlaybookDraft extends PlaybookBody {
  key: string;
  tenantId: string;
  playbookId: string;
  updatedBy: string;
  updatedAt: string;
}

/** IMMUTABLE once written (put-if-absent): a published version is never overwritten. */
export interface PlaybookVersion extends PlaybookBody {
  key: string;
  tenantId: string;
  playbookId: string;
  version: string;
  /** sha256 over canonical(body) — what an installation and a run stamp name. */
  contentHash: string;
  publishedBy: string;
  publishedAt: string;
  supersedes?: string;
}

export interface PlaybookInstallHistoryEntry {
  version: string;
  revision: string;
  at: string;
  by: string;
  /** The layers this version ran with — a rollback restores exactly these (D6.5). */
  layers?: { agency?: ConfigLayer; client?: ConfigLayer };
  rolloutId?: string;
  operationId?: string;
}

/** Durable intent written before a workflow upgrade; retries reconcile this operation. */
export interface PlaybookUpgradeIntent {
  operationId: string;
  version: string;
  contentHash: string;
  layersHash: string;
  revision: string;
  expectHead: string | null;
  layers: { agency?: ConfigLayer; client?: ConfigLayer };
  by: string;
  at: string;
  rolloutId?: string;
}

/** D6.3/D6.6 — a client's place in staged rollouts; `held` is skipped by every rollout. */
export type PlaybookRing = 'canary' | 'early' | 'general' | 'held';
export const RING_ORDER: readonly Exclude<PlaybookRing, 'held'>[] = ['canary', 'early', 'general'];

/** One owned workflow per (client, playbook) (D4). */
export interface PlaybookInstallation {
  key: string;
  tenantId: string;
  orgId: string;
  playbookId: string;
  /** `installing` is the uniqueness claim taken before anything is written. */
  status: 'installing' | 'installed';
  claimedAt: string;
  pinnedVersion: string;
  contentHash: string;
  workflowId?: string;
  /** `revisionHashOf` the definition the install wrote. A head that differs is a builder edit. */
  expectedRevision?: string;
  layers: { agency?: ConfigLayer; client?: ConfigLayer };
  /** sha256 over the merged parameter values this install expanded with. */
  layersHash?: string;
  installedBy: string;
  history: PlaybookInstallHistoryEntry[];
  /** D6.3 — absent = `general`. */
  ring?: PlaybookRing;
  pendingUpgrade?: PlaybookUpgradeIntent;
}

/** Workflow id → installation, for the run-start stamp (a point read, host-written). */
export interface PlaybookWorkflowIndex {
  key: string;
  tenantId: string;
  workflowId: string;
  orgId: string;
  playbookId: string;
}

/** The host-written run stamp (ADR 0959 D8). Reserved: a caller can never supply it. */
export const PLAYBOOK_RUN_STAMP_KEY = 'openwop-app.playbook';

export interface PlaybookRunStamp {
  playbookId: string;
  version: string;
  contentHash: string;
  orgId: string;
  layersHash: string;
  /** D3 — `edited`: the run's pinned definition is not the one the install wrote (a builder
   *  edit); `unknown`: the run carries no `definitionRevision` to compare. */
  drift: 'none' | 'edited' | 'unknown';
}

/** D3 — what an installation's workflow looks like now. */
export type InstallationDrift = 'none' | 'edited' | 'missing';

/** D3 layer 1 — the agency's values for one playbook, applied to every client. */
export interface PlaybookAgencyLayer extends ConfigLayer {
  key: string;
  tenantId: string;
  playbookId: string;
  updatedBy: string;
  updatedAt: string;
}
