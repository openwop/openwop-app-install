/**
 * Campaign ops (agency campaign operations) — shared types.
 *
 * ADR 0921 (client accounts) and ADR 0922 (assets + destinations). An agency is
 * a `ws:` workspace; each client is a non-root org in it. Every row here carries
 * the client `orgId` and is keyed by it.
 *
 * @see docs/adr/0921-campaign-ops-agency-client-accounts.md
 * @see docs/adr/0922-campaign-ops-asset-registry-and-destinations.md
 */

export type ClientStatus = 'active' | 'paused' | 'archived';
export type ClientMode = 'preview' | 'live';

/** ADR 0921 D1 — a client account over an existing org. */
/** ADR 0962 D7. `auto-within-caps` is not offered (Q1 open). */
export type ExternalAgentsAccess = 'off' | 'read' | 'request';
export const EXTERNAL_AGENTS_LEVELS: readonly ExternalAgentsAccess[] = ['off', 'read', 'request'];

export interface ClientAccount {
  tenantId: string;
  /** The client org — the ONLY isolation key. Never the workspace root. */
  orgId: string;
  displayName: string;
  status: ClientStatus;
  /** ADR 0926 D3 — new clients start in preview (nothing is written). */
  mode: ClientMode;
  /** ADR 0924 D4 — `agency` (P0) or `client` (P1: a client approver decides
   *  through the portal). `client_and_agency` is P2. */
  approvalPolicy: ApprovalPolicyMode;
  /** ADR 0927 D2 — demo rows. */
  synthetic?: true;
  /** ADR 0962 D7 — what outside agents (MCP) may do for this client. Absent ⇒ `off`. */
  externalAgents?: ExternalAgentsAccess;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export type ApprovalPolicyMode = 'agency' | 'client';
export const APPROVAL_POLICY_MODES: readonly ApprovalPolicyMode[] = ['agency', 'client'];

/**
 * ADR 0924 D5 (P1) — a person at the client who decides change sets through the
 * portal. NOT an org member and never a session: they act only through a sharing
 * link minted for one change set. Shaped as ADR 0958's `ExternalCollaborator` of
 * kind `client-stakeholder`. Since ADR 0958 P1 it is the agency-facing VIEW of
 * that collaborator (`approverId` = `collaboratorId`); the row is the collaborator.
 */
export interface ClientApprover {
  tenantId: string;
  orgId: string;
  approverId: string;
  kind: 'client-stakeholder';
  /** PII, declared: shown to the agency only, never on the public page or an approval row. */
  email: string;
  displayName: string;
  /** `suspended` is set through the ADR 0958 collaborators panel. */
  status: 'active' | 'suspended' | 'revoked';
  mode: 'link-only';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

/** ADR 0924 D5 — one approval link: (change set, approver). The sharing link row
 *  holds the token; this row records who sent it, which is the agency authority
 *  the approved change is written under (a client approver has none). */
export interface ApprovalLinkRecord {
  tenantId: string;
  orgId: string;
  changeSetId: string;
  approverId: string;
  /** ADR 0958 P1 — the `decide` grant behind the link. Absent on a pre-P1 record,
   *  whose link is not honoured (it is re-sent). */
  grantId?: string;
  sentBy: string;
  sentAt: string;
}

export type DestinationKind = 'openwop.cms.page' | 'openwop.email.template';
export const DESTINATION_KINDS: readonly DestinationKind[] = ['openwop.cms.page', 'openwop.email.template'];

/** ADR 0922 D3 — a CMS page of the client org. */
export type PageLocator = { pageId: string };
/** ADR 0922 D5 — an ADR 0905 email template of the client org, plus the campaigns
 *  that send it (checked, with every campaign referencing it, before a write). */
export type TemplateLocator = { templateId: string; campaignIds?: string[] };
export type AssetLocator = PageLocator | TemplateLocator;

/** ADR 0922 D1 — one asset of one client. */
export interface CampaignAsset {
  tenantId: string;
  orgId: string;
  assetId: string;
  campaignId?: string;
  destination: DestinationKind;
  locator: AssetLocator;
  label: string;
  /** ADR 0922 D4 — the only fields a change set may touch. */
  editableFields: string[];
  lastKnown?: { version: number; contentHash: string; readAt: string };
  synthetic?: true;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/** ADR 0922 D2 — what an adapter reads. `fields` holds every editable-in-principle
 *  text field by its path; `editableFields` on the asset narrows it. */
export interface AssetSnapshot {
  version: number;
  contentHash: string;
  fields: Record<string, string>;
  state: { status: string };
}

/** ADR 0922 D4 — a constrained, field-addressed edit. */
export type ConstrainedEdit =
  | { field: string; before: string; after: string }
  | { field: string; find: string; replace: string };

export type WriteRefusal =
  | 'not_editable'        // a field outside `editableFields`
  | 'edit_mismatch'       // `before` / `find` no longer matches the source
  | 'not_authorized'      // the acting user lacks the destination's own authority
  | 'publish_blocked'     // the destination refused the content (e.g. a live page's publish blockers)
  | 'email_already_sent'  // ADR 0922 D5: a campaign sending or sent this template; sent email is never changed
  | 'destination_unavailable' // the destination's own feature is off for this tenant
  | 'creative_blocked'    // ADR 0945 D5 — the edit puts AI creative that failed the publish gate on the page
  | 'asset_gone';

export type WriteOutcome =
  | { kind: 'written'; version: number }
  | { kind: 'version_conflict'; currentVersion?: number }
  | { kind: 'refused'; reason: WriteRefusal; detail?: string };

export interface AdapterContext {
  tenantId: string;
  /** The person on whose authority the write runs (ADR 0921 D3: never actorless). */
  actingUserId: string;
}

/** ADR 0922 D2 — one interface per destination kind. */
export interface DestinationAdapter {
  kind: DestinationKind;
  /** Returns null when the target does not exist IN THIS CLIENT ORG (a missing
   *  page and another client's page are indistinguishable by design). */
  read(asset: Pick<CampaignAsset, 'orgId' | 'locator'>, ctx: Pick<AdapterContext, 'tenantId'>): Promise<AssetSnapshot | null>;
  /** The asset with `edits` applied, without writing: the source identity it was
   *  computed against and the target hash read-back must observe. */
  preview(
    asset: Pick<CampaignAsset, 'orgId' | 'locator' | 'editableFields'>,
    edits: readonly ConstrainedEdit[],
    ctx: Pick<AdapterContext, 'tenantId'>,
  ): Promise<
    | { sourceVersion: number; sourceContentHash: string; targetFieldsHash: string; before: Record<string, string>; after: Record<string, string> }
    | { refused: WriteRefusal; field?: string }
  >;
  write(
    asset: Pick<CampaignAsset, 'orgId' | 'locator' | 'editableFields'>,
    edits: readonly ConstrainedEdit[],
    opts: { expectedVersion: number },
    ctx: AdapterContext,
  ): Promise<WriteOutcome>;
}

// ── ADR 0923 — change requests and change sets ───────────────────────────────

/** ADR 0923 D2 — the v1 intent vocabulary. */
export type Intent =
  | { kind: 'set_field_value'; subject: string; value: string; evidence: string }
  | { kind: 'replace_text'; find: string; replace: string; evidence: string };

export interface Question { id: string; slot: string; prompt: string; options?: string[] }

/** Ask XOR act: exactly one of the two lists is non-empty. */
export interface Interpretation { intents: Intent[]; questions: Question[] }

export interface Answer { questionId: string; value: string; answeredBy: string; answeredAt: string }

export type RequestStatus =
  | 'interpreting'   // a run is working on it
  | 'needs_facts'    // the planner asked questions
  | 'proposing'
  | 'proposed'       // a change set exists for this version
  | 'no_changes'     // nothing in the assets matched the intents
  | 'failed'
  | 'superseded'     // a newer version exists
  | 'duplicate';

/** ADR 0923 D1 — one row per version. */
export interface ChangeRequest {
  tenantId: string;
  orgId: string;
  requestId: string;
  version: number;
  text: string;
  campaignId?: string;
  /** The assets this request may touch (ADR 0922 assets of the same client). */
  assetIds: string[];
  answers: Answer[];
  interpretation?: Interpretation;
  status: RequestStatus;
  failure?: { code: string; message: string };
  fingerprint?: string;
  duplicateOf?: string;
  duplicateOverride?: { reason: string; by: string; at: string };
  changeSetId?: string;
  runIds: string[];
  /** ADR 0962 D6 — set when an outside agent (MCP) made the request. */
  via?: { protocol: 'mcp'; runId?: string };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeSetEntry {
  assetId: string;
  destination: DestinationKind;
  label: string;
  sourceVersion: number;
  sourceContentHash: string;
  edits: ConstrainedEdit[];
  /** Hash of the asset's editable fields after the edits (see `fieldsHash`). */
  targetContentHash: string;
}

export type ChangeSetStatus = 'proposed' | 'in_review' | 'approved' | 'rejected' | 'stale' | 'executing' | 'finished';

/** ADR 0923 D4 — immutable once proposed, except `status` (by CAS). */
export interface ChangeSet {
  tenantId: string;
  orgId: string;
  changeSetId: string;
  requestId: string;
  requestVersion: number;
  entries: ChangeSetEntry[];
  /** ADR 0923 D6. */
  hash: string;
  status: ChangeSetStatus;
  staleReason?: 'request_changed' | 'asset_changed';
  model?: { provider?: string; model?: string };
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * ADR 0943 D2 — a client's replacement for the agent a chain pins on its
 * agent-runner nodes. Keyed by the PINNED agent id (no role vocabulary in code),
 * optionally narrowed to one workflow or one node of it. Frozen into each run at
 * start; never read live by a running node.
 */
export interface ClientAgentBinding {
  tenantId: string;
  /** The client — the only isolation key. */
  orgId: string;
  /** Hash of (pinnedAgentId, workflowId?, nodeId?): one row per scope. */
  bindingId: string;
  /** The chain's default pin this binding replaces. */
  pinnedAgentId: string;
  workflowId?: string;
  nodeId?: string;
  /** The replacement (a pack agent or a tenant agent). */
  agentId: string;
  /** ADR 0943 D6 — optional model pin; `credentialRef` must be a stored key of the tenant. */
  model?: { provider: string; model: string; credentialRef?: string };
  updatedAt: string;
  updatedBy: string;
}

/** ADR 0943 D2 — what a run carries per bound node (`run.metadata['openwop-app.agentBindings']`). */
export interface FrozenAgentBinding {
  agentId: string;
  bindingId: string;
  model?: { provider: string; model: string; credentialRef?: string };
}
