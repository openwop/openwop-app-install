/**
 * Pending-approval queue — host extension (non-normative).
 *
 * The reference implementation of the "agents propose, humans dispose" gate.
 * When a roster member runs at `autonomyLevel: 'review'` (host/rosterService.ts)
 * its heartbeat does NOT start the picked run; it queues a PendingApproval here
 * describing the proposed action (which workflow, on which board card). A human
 * reviews the proposal in the approvals inbox and either:
 *   - CLAIMS it — an affirmative sign-off that starts the proposed run, OR
 *   - REJECTS it — the proposal is dismissed and the card stays in To Do.
 *
 * This is a PRE-EXECUTION gate, deliberately distinct from the normative
 * `interrupt` kind (interrupt.md), which suspends a run that is already
 * in flight. The propose moment in this sample is the heartbeat's pick
 * decision — before any run exists — so a lightweight durable queue models it
 * more honestly than forcing every demo workflow to carry an approval node.
 *
 * Read-through, per-entity durable store (host/hostExtPersistence.ts): safe
 * across instances + restart-durable, like the roster/kanban surfaces.
 */

import { randomUUID, createHash } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { appendAudit, AUDIT_KIND_GOVERNANCE_DECISION } from './auditChainService.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';
import { registerRetentionPurger, purgeRowsByAge, type PurgeOutcome } from './retentionPurger.js';
import { createLogger } from '../observability/logger.js';
import { OpenwopError } from '../types.js';

const auditLog = createLogger('host.approvalService');

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** Every approval `kind` discriminator (absent on a row ⇒ `run-proposal`). This
 *  tuple is the RUNTIME source of truth the APPR-5 redactor-completeness test
 *  enumerates; `ApprovalKind` derives from it so the type and the list can never
 *  drift (adding a kind to the type means adding it here, which the test then
 *  requires a redactor for). */
export const APPROVAL_KINDS = [
  'run-proposal',
  'assistant-action',
  'content-publish',
  'campaign-spend',
  'commerce-spend',
  'strategy-activation',
  'strategy-checkin',
  'pm-scenario-select',
  'contact-merge',
  'warehouse-load',
  'challenge-publish',
  'community-profile',
  'community-review',
  'metrics-verifier-sample',
  'connect-seller',
  'kicktodo-plan-proposal',
  'environment-promotion',
  'dealer-registration',
  'territory-model-transition',
  'commission-statement',
  'commerce-listing-publish',
  'anon-surface-write',
  'composed-workflow',
  'compensation-action',
  'claude-code-permission',
  'campaign-change-set',
  'email-campaign-send',
  'playbook-rollout',
  // ADR 0945 × 0942 — a person's approval to publish ONE asset at ONE fidelity verdict.
  'creative-publish-review',
  'funnel-publish',
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** A proposed-but-unstarted action awaiting human sign-off. */
export interface PendingApproval {
  /** `appr:<uuid>`. */
  approvalId: string;
  /**
   * ADR 0672 D3 — the row resolved `rejected`, but the review was OVERTAKEN, not declined.
   * A flag, deliberately NOT a fourth `ApprovalStatus`: the status union is baked into the
   * secondary-index id and iterated as a 3-tuple, so widening it would force an index
   * migration and touch every status consumer. This is additive and index-free — and it is
   * what makes the chain's `superseded` outcome REACHABLE from the submitter surface, which
   * reads the row and never the chain.
   */
  superseded?: boolean;
  tenantId: string;
  /** The roster member that proposed the action. */
  rosterId: string;
  persona: string;
  /** The workflow the member proposes to run. */
  workflowId: string;
  /** ADR 0023 §12 T4 — when set, this approval carries an Executive-Assistant
   *  outbound action (`PendingAction.actionId`): the SAME queue, inbox, and
   *  claim/reject flow (ADR 0025 §4 "no new approval store"); the claim route
   *  branches here instead of starting `workflowId` (execution is T6). */
  actionId?: string;
  /** ADR 0311 P2 — the chat conversation this proposal traces back to (the
   *  filed todo's origin). Read-side: the review projection filters on it so
   *  the approval card surfaces in that conversation. Additive. */
  conversationId?: string;
  /** ADR 0313 P2 — run-level `configurable` the approved dispatch carries
   *  (the bare-card fallback freezes the agent-turn task here; without it an
   *  approved fallback run would start the turn-workflow with no variables
   *  and fail agent-runner validation). Additive; absent for classic
   *  proposals whose workflows need no inputs. */
  configurable?: Record<string, unknown>;
  /** ADR 0775 P3b — a run proposal filed by a SCHEDULE slot whose workflow is on
   *  the agent's `hitl` list. Approving it fires that job through the daemon's
   *  own recipe (`fireJob`), so the run carries the job's inputs and attribution
   *  exactly as an unheld fire would. Additive. */
  scheduleJobId?: string;
  /** Discriminator for renderers; absent ⇒ 'run-proposal' (back-compat). The
   *  union derives from the `APPROVAL_KINDS` tuple above (single source of truth). */
  kind?: ApprovalKind;
  /** ADR 0385 (chat-first-port F3) — when `kind: 'commerce-listing-publish'`, this
   *  approval gates an operator's decision on a seller's native-paid/external-link
   *  marketplace listing. `rosterId`/`persona`/`workflowId` are empty (no agent,
   *  no run); the decide path is the commerce-connect feature's registered handler,
   *  which enforces SUPERADMIN authority (the approver is NEVER the seller — the
   *  CLAUDE.md multi-tenant phishing/squat posture) and flips the listing's
   *  `approvalState` mirror. Stored under the SELLER's tenant; `version` is the
   *  material fingerprint so a re-submitted identical change reuses the row and a
   *  material edit supersedes it. SAME queue + inbox + CAS resolve (ADR 0025 §4). */
  commerceListing?: { packName: string; sellerTenantId: string; lane: string; version: string };
  /** ADR 0785 P4 — when `kind: 'claude-code-permission'`, a permission prompt from
   *  the user's own Claude Code (a headless task routed it here through
   *  `--permission-prompt-tool`). The decision IS the whole act: the waiting MCP
   *  tool reads the decided row and answers Claude Code allow/deny. Visible to and
   *  decidable by ONLY the device's human (`policy.approverRefs[0]`). The input is
   *  summarised and digested, never stored wholesale (it may carry secrets). */
  claudeCodePermission?: { deviceId: string; deviceLabel: string; tool: string; summary: string; inputDigest: string };
  /** ADR 0554 P2 / RFC 0151 §E — when `kind: 'compensation-action'`, this
   *  approval gates ONE inverse effect the host is about to fire while
   *  unwinding a failed run. `rosterId`/`persona` carry a host marker (no agent
   *  proposed it — the executor did, while a run was dying); `workflowId` names
   *  the run's workflow so the card reads as an operator decision about a known
   *  workflow.
   *
   *  Content-free on purpose: `compensationId` is the RFC 0151 §C hashed
   *  inverse-action id, `nodeId` the forward node, and nothing derived from the
   *  effect's payload appears. §G puts compensation credentials and provider
   *  bodies out of bounds on the durable path, and an approval row an operator
   *  reads is on that path. `requestedBy` is the run's acting human, and is what
   *  the separation-of-duties check compares the decider against. */
  compensationAction?: {
    runId: string;
    compensationId: string;
    nodeId?: string;
    compensationNodeTypeId: string;
    requestedBy?: string;
  };
  /** ADR 0469 — when `kind: 'anon-surface-write'`, this approval HOLDS a bounded
   *  write/egress a PUBLIC-widget anonymous visitor requested (ADR 0468 tier).
   *  `rosterId`/`persona`/`workflowId` are empty (no agent, no run); the decide
   *  path is `anonymousActor`'s registered handler, which on APPROVE re-runs the
   *  held `tool` call tenant-scoped with `actingUserId` undefined (the no-secret
   *  floor) + `guardAnonEgress`, and on REJECT does nothing. Stored under the
   *  SURFACE tenant + `orgId` (the widget's org — the `workspace:write` RBAC anchor
   *  for `approvalVisible`). `capturedName`/`capturedEmail`/`capturedNote` are the
   *  visitor's untrusted PII — kept FLAT (2-level) so the APPR-5 redactor can
   *  scrub them; the actor stays the OPAQUE `principal` (non-PII). `runId` +
   *  `toolCallIdx` give the deterministic idempotency key. */
  anonSurfaceWrite?: {
    widgetId: string;
    principal: string;
    runId: string;
    toolCallIdx: number;
    tool: { name: string; args?: Record<string, unknown>; destination?: string };
    capturedName?: string;
    capturedEmail?: string;
    capturedNote?: string;
  };
  /** CHAT-FIRST-PORT-AUDIT D3 — when `kind: 'strategy-checkin'`, this approval
   *  gates the confirm/dismiss of an AGENT-proposed strategy check-in (the ADR
   *  0231 measurement proposal). `rosterId`/`persona`/`workflowId` are empty (no
   *  run); the decide path is the strategy feature's registered handler, which on
   *  approve CONFIRMS the check-in and on reject DISMISSES it. SAME queue + inbox
   *  + CAS resolve as every other gate. Reuses top-level `strategyId` + `orgId`
   *  (the RBAC anchor — the check-in decide bar is `workspace:write` in that org). */
  strategyCheckIn?: { checkInId: string; krId: string; krTitle?: string };
  /** CHAT-FIRST-PORT-AUDIT D3 — when `kind: 'pm-scenario-select'`, this approval
   *  gates adopting an AGENT-proposed Priority-Matrix scenario as the plan of
   *  record (ADR 0235 §D1). `rosterId`/`persona`/`workflowId` are empty (no run);
   *  the decide path is the priority-matrix feature's registered handler, which on
   *  approve SELECTS the scenario as plan of record (and on reject leaves it
   *  un-adopted — selection executes nothing, architect Q1). Reuses top-level
   *  `orgId` (the decide bar is `workspace:write` in the list's org). */
  scenarioSelect?: { listId: string; sessionId: string; scenarioId: string; scenarioName?: string };
  /** CFP-1 (D9) — when `kind: 'dealer-registration'`, this approval gates a
   *  partner-submitted deal registration's approve/reject. `rosterId`/`persona`/
   *  `workflowId` are empty (no agent, no run); the decide path is the dealers
   *  feature's registered handler, which flips the registration on approve/reject.
   *  Visible only to `host:dealers:manage` in `orgId`. SAME queue + inbox + CAS. */
  /** ADR 0473 — when `kind: 'composed-workflow'`, this approval HOLDS an
   *  agent-composed workflow proposal: the draft is ALREADY registered as an
   *  ADR 0369 transient definition (`workflowId`, catalog-hidden, builder-
   *  editable) and NOTHING runs until a human claims. `definitionHash` pins the
   *  exact definition reviewed (approve-what-you-see — the decide handler
   *  re-verifies it AFTER its CAS, so a builder edit racing the claim can never
   *  run unreviewed); `expiresAt` TTLs the proposal; `runInputs` are the frozen
   *  run inputs the approved dispatch carries. The decide path is the
   *  registered composed-workflow handler (host/workflowComposeTool.ts), which
   *  on APPROVE starts the run via the ONE `startWorkflowRun` recipe and on
   *  REJECT archives the draft. No PII by contract: the proposer is an agent
   *  (`agentProfileId`), text rides `proposal` (redactor-covered). */
  composedWorkflow?: {
    definitionHash: string;
    agentProfileId?: string;
    nodeCount: number;
    edgeCount: number;
    expiresAt?: string;
    runInputs?: Record<string, unknown>;
    /** ADR 0473 (grade-code C2) — the LIVE hash the decide VERIFIED and ran
     *  (may differ from the propose-time pin when the reviewer approved an
     *  edited draft). Written by the decide handler alongside `runId`, so
     *  "what definition did the reviewer approve?" stays answerable after
     *  further edits. */
    approvedDefinitionHash?: string;
    /** ADR 0476 §3 — the static composition cost floor at propose time. */
    estimatedFloorUsd?: number;
    estimatedAiNodes?: number;
    /** Grade-data H1 (ADR 0473/0478 correction) — the ACTING USER whose
     *  conversation produced this proposal. This is the first-party subject
     *  id the erasure redactor matches on: `proposal` and `reasoning` are
     *  agent prose composed FROM that user's conversation and may quote them
     *  verbatim. Absent on legacy rows (their text redaction remains
     *  unreachable — KNOWN RESIDUAL; teardown is the backstop). */
    proposedByUserId?: string;
  };
  dealerRegistration?: { regId: string; dealerId: string };
  /** CFP-1 (D9) — when `kind: 'territory-model-transition'`, this approval gates a
   *  territory MODEL activation/archival (org-wide CRM-visibility blast radius).
   *  The decide path is the territories feature's handler, which activates/archives
   *  the model on approve. Visible only to `host:territories:manage` in `orgId`. */
  territoryTransition?: { modelId: string; transition: 'activate' | 'archive' };
  /** CFP-1 (D9) — when `kind: 'commission-statement'`, this approval gates a
   *  commission statement's `draft → approved` transition (payout-committing). The
   *  decide path is the sales-commissions feature's handler, which approves the
   *  statement (ADR 0280 §8: the statement row IS the payout record; the host moves
   *  NO money). `total`/`currency` are display-only for the review card (the
   *  statement's own major-unit total). `subjectId` is the rep (a data subject →
   *  redacted on erasure). Visible only to `host:commissions:manage` in `orgId`.
   *  Obligation-ledger accrual (ADR 0447) is deferred — see the D9 port map
   *  BLOCKER 4 note: it needs a major→minor currency-exponent conversion that is a
   *  separate money-precision change, and the statement row already satisfies the
   *  money invariant. */
  commissionStatement?: { statementId: string; subjectId: string; period: string; total: number; currency: string };
  /** ADR 0387 / H2 — when `kind: 'environment-promotion'`, this approval gates a
   *  config promote/rollback (a pointer move) behind the tenant's opt-in
   *  `requireApprovalForPromotion`. `rosterId`/`persona`/`workflowId` are empty
   *  (no agent, no run); the decide path is the environments feature's registered
   *  handler, which on approve performs the pointer move (`movePointer`) and on
   *  reject parks a rejected ledger row. SAME queue + inbox + CAS resolve. */
  /** ADR 0732 — `requestedBy` is the PROPOSER, recorded so a decide can refuse
   *  self-approval. Optional only for rows minted before that ADR (D5). */
  envPromotion?: { toEnv: string; fromEnv: string | null; snapshotHash: string; requestedBy?: string };
  /** ADR 0459 P2 — when `kind: 'kicktodo-plan-proposal'`, this approval carries a
   *  coach's plan-change proposal whose DECIDER is the participant (the inverse
   *  of publication's separation-of-duties: the subject of the change holds the
   *  authority). `rosterId`/`persona`/`workflowId` are empty (no agent, no run);
   *  the decide path is `kicktodo-accountability`'s registered handler, which
   *  delegates to `resolveProposal` — the ONE plan-applier, whose enrollment-owner
   *  check remains the authority. The participant subject is carried in
   *  `policy.approverRefs[0]` (also the visibility key — see reviewProjection). */
  planProposal?: { circleId: string; enrollmentId: string; proposalId: string; coachSubject: string; note: string };
  /** ADR 0415 D3 — when `kind: 'challenge-publish'`, this approval gates a
   *  KickTodo Challenge Factory candidate's publication into the kicktodo-core
   *  catalog. Separation of duties is enforced at the completing seam: the
   *  resolver MUST differ from `challengePublish.submittedBy`. */
  challengePublish?: { candidateId: string; challengeId: string; challengeVersion: number; submittedBy: string };
  /** ADR 0426 — `community-profile`/`community-review` payload (opaque ref). */
  community?: { refId: string; submittedBy: string };
  /** ADR 0445 D2 — when `kind: 'connect-seller'`, this approval gates a KickTodo
   *  AUTHOR'S request for payout onboarding (the seller lanes are approval-gated —
   *  the CLAUDE.md multi-tenant phishing/squat posture). The Connect account
   *  itself stays the tenant's ONE seller row via the existing Connect lane. */
  connectSeller?: { submittedBy: string };
  /** ADR 0264 / CDP-B — when `kind: 'contact-merge'`, this approval gates a steward
   *  contact merge (a probabilistic match candidate). `rosterId`/`persona`/`workflowId`
   *  are empty (no agent, no run); the decide path is the crm feature's merge handler,
   *  which calls `mergeContacts` on approve. SAME queue + inbox + CAS resolve. */
  survivorContactId?: string;
  sourceContactId?: string;
  /** ADR 0066 — when `kind: 'content-publish'`, this approval gates a CMS page's
   *  publish (`draft → in_review → published`). `rosterId`/`persona`/`workflowId`
   *  are empty (no agent, no run); the decide path is the CMS feature's
   *  content-approval handler, which transitions the page. The SAME queue +
   *  inbox + CAS resolve (ADR 0025 §4 "no new approval store"). */
  orgId?: string;
  pageId?: string;
  pageTitle?: string;
  /** UX_UPGRADE-content R2 (CMS2-M1) — the page's `version` AT SUBMIT TIME, so
   *  the decide path can refuse to publish content the reviewer never saw. The
   *  row froze only the TITLE, while `transitionPage('approve')` re-checked
   *  nothing but `from:['in_review']` and stamped whatever the page contained
   *  at decide time: a submitter could keep editing an in-review page (the
   *  PATCH route allows it at admin tier) and the reviewer's approve would put
   *  the LATER content live under the reviewer's name. Absent on rows created
   *  before this shipped ⇒ the staleness check is skipped, never failed. */
  pageVersion?: number;
  /** ADR 0593 D4 (CMSAU-4) — the locales this page carries MACHINE-DRAFTED
   *  overlays for, derived from the durable per-section `aiDrafted` stamps
   *  (ADR 0592 §3) at queue AND repin time.
   *
   *  Provenance used to reach the reviewer as one English sentence built from
   *  THIS submit's translate sweep. The sweep is missing-only, so on any
   *  resubmit — including the reject → fix → resubmit loop the gate is FOR —
   *  nothing new was drafted, the sentence was rebuilt empty, and the repin
   *  OVERWROTE the disclosure: the same unreviewed machine drafts, now
   *  presented as provenance-clean. Derived state cannot decay that way. */
  aiDraftedLocales?: string[];
  /** ADR 0859 D3 / ADR 0905 — everyone who submitted a content/email review cycle
   *  (a UNION across resubmits, never overwritten — an overwrite let a second
   *  person's resubmit erase the first submitter and with it the separation-of-duties
   *  check). Subject ids, erased by the owning kind's redactor. */
  submitters?: string[];
  /** ADR 0859 D4 / ADR 0905 — members who CAUSED an actorless run that
   *  submitted this review (a channel poster, a schedule's author). Counted by the
   *  separation-of-duties check ONLY — never told anything, because the causing
   *  member is not the run's actor (ADR 0832 D3). Unioned like `submitters`. */
  submitterCauses?: string[];
  /** ADR 0942 — originating campaign run, for canonical requester/owner checks.
   *  This is a reference, not `runId` (which names a run started by a claim). */
  autonomySourceRunId?: string;
  /** ADR 0859 D5 (ADR 0594 D1) — `content-publish` only: the page's sections that
   *  resolve LIVE at read time (a registered content-section resolver), so the
   *  reviewer is told their approval does not freeze what those sections show.
   *  Derived at queue AND repin time, like `aiDraftedLocales`. */
  liveReferenceSections?: Array<{ sectionId: string; type: string }>;
  /** ADR 0861 D6 addendum (ADR 0859 OQ-1, owner decision 2026-10-11) —
   *  `content-publish` only: the configured locales with at least one OUTDATED
   *  section translation at the pinned version. INFORMATION for the reviewer, never
   *  a block on the decision. Derived at queue AND repin time from
   *  `pageTranslationStatus` — the SAME function the editor's translation status
   *  reads — so the card and the editor cannot disagree. */
  outdatedTranslationLocales?: string[];
  /** ADR 0905 D3 — when `kind: 'email-campaign-send'`, this approval gates sending ONE
   *  email campaign: this content (template version + hash), from this sender, to this
   *  audience DEFINITION (never its membership — consent and suppression are evaluated
   *  at send). `subject`/`body` are the pinned version's text, so the inbox card shows
   *  exactly what is approved. Opaque to core; `features/email/sendApproval.ts` owns
   *  the shape and the decide handler. Approver refs (ADR 0075) ride `policy` with
   *  `requiredApprovals: 1`, so the quorum path stays inert and the handler checks
   *  eligibility itself. `submitters` (above) records who asked. */
  emailSend?: {
    /** Digest of the complete displayed send review, distinct from template contentHash. Legacy rows must be resubmitted. */
    reviewHash?: string;
    campaignId: string;
    templateId: string;
    templateVersion: number;
    contentHash: string;
    senderAddress: string;
    audienceHash: string;
    /** Display-only description of the audience (`stage: lead`, a segment name). */
    audienceLabel: string;
    templateName: string;
    subject: string;
    body: string;
    format?: 'text' | 'markdown' | 'sms';
    /** The recipient count at submit time — an ESTIMATE (membership resolves at send). */
    estimatedRecipients?: number;
  };
  /** Host-only ownership generation: even an identical resubmit changes the
   *  exact CAS snapshot. Deliberately outside the displayed semantic digest. */
  emailSendRevision?: string;
  /** ADR 0948 P1b — when `kind: 'funnel-publish'`, this approval gates publishing ONE
   *  funnel exactly as it was when requested: `digest` pins its slug, steps, offers,
   *  campaign and completion CTA, so an edit after the request makes the decision
   *  stale. Opaque to core; `features/funnels/funnelPublishApproval.ts` owns the shape,
   *  the decide handler and the one publish function. */
  funnelPublish?: {
    funnelId: string;
    funnelName: string;
    slug: string;
    digest: string;
    stepCount: number;
    /** The run that asked, when a workflow node asked (display + audit only). */
    runId?: string;
    /** ADR 0948 P1b × ADR 0942 — the autonomy gate this review carries: the policy
     *  hash + rule that resolved `content.publish` to approve, or absent for a review
     *  decided by the org's writers alone. Part of the row identity, so a review
     *  without named approvers can never stand in for one that has them. */
    gate?: string;
  };
  /** Campaign gap plan §5B B3 — when `kind: 'campaign-spend'`, this approval
   *  gates a live ad-platform spend action (dispatch or budget-set) that met the
   *  tenant's `adSpend.approvalThresholdMinor`. `rosterId`/`persona`/`workflowId`
   *  are empty (no agent, no run); the decide path simply flips status — the ads
   *  adapter re-checks the record (keyed by `spendIdemKey`) on the next attempt.
   *  SAME queue + inbox + CAS resolve (ADR 0025 §4 "no new approval store"). */
  spendKind?: 'publish' | 'budget' | 'audience' | 'launch' | 'reallocation' | 'order' | 'refund';
  platform?: string;
  briefId?: string;
  adAccountId?: string;
  platformCampaignId?: string;
  dailyBudgetMinor?: number;
  /** The adapter's fork-stable spend key this approval is bound to. Reused by
   *  `kind: 'warehouse-load'` (ADR 0292) as the per-batch idempotency key so an
   *  approve-then-rerun of the SAME warehouse batch proceeds and a `:fork` can't re-ask. */
  spendIdemKey?: string;
  /** ADR 0945 × 0942 — when `kind: 'creative-publish-review'`: the asset, the
   *  verdict it was approved AT, and the content hash the publish gate checks. */
  assetId?: string;
  verdictId?: string;
  reviewHash?: string;
  /** ADR 0292 / CDP-D §6 — when `kind: 'warehouse-load'`, this approval gates a
   *  reverse-ETL BigQuery `insertAll` (the `warehouse.load` action policy defaults to
   *  `approval-required`, fail-closed). `rosterId`/`persona`/`workflowId` are empty (no
   *  agent, no run); the decide path flips status and the destination-sync
   *  `warehouseLoadService` re-checks the record (keyed by `spendIdemKey`) on the next
   *  attempt. Ids + row COUNT only — NEVER row bodies (subject data) or credentials. */
  syncId?: string;
  dataset?: string;
  table?: string;
  rowCount?: number;
  /** Ecommerce gap plan §5B B3 — when `kind: 'commerce-spend'`, this approval
   *  gates an order-value or refund-value commerce action that met the tenant's
   *  `commerce.{order,refund}ApprovalThresholdMinor`. Same posture as
   *  `campaign-spend`: no agent, no run; the decide path flips status and the
   *  commerce service re-checks the record (keyed by `spendIdemKey`) on the
   *  next attempt. SAME queue + inbox + CAS resolve (ADR 0025 §4). */
  orderId?: string;
  amountMinor?: number;
  amountCurrency?: string;
  /** ADR 0230 §B3 — when `kind: 'strategy-activation'`, this approval gates a
   *  strategy's `draft → active` transition (`strategy-approval-gate` toggle).
   *  `rosterId`/`persona`/`workflowId` are empty (no agent, no run); the decide
   *  path is the strategy feature's activation handler, which transitions the
   *  strategy. SAME queue + inbox + CAS resolve (ADR 0025 §4 "no new approval
   *  store"). Reuses `orgId` above for the RBAC anchor. */
  strategyId?: string;
  strategyTitle?: string;
  /** ADR 0597 §3 — the strategy status this activation was queued FROM. The
   *  gate keys on the DESTINATION (`→ active`), so the origin is no longer
   *  always `draft`; the decide handler compares the live status against THIS
   *  to hold "approve what you see". Absent on rows queued before ADR 0597 —
   *  every one of those was queued from `draft`. */
  strategyFromStatus?: string;
  /** ADR 0845 D2 — what the approver is shown and what the approval binds to: the
   *  strategy's protected content plus where it lives (`orgId`, `scope`), frozen at
   *  queue time from the row the submission wrote. Opaque to core; the strategy
   *  feature owns its shape (`activationApproval.StrategyActivationBinding`). */
  strategySnapshot?: Record<string, unknown>;
  /** ADR 0845 D2 — sha256 over the canonical JSON of `strategySnapshot`. The decide
   *  handler refuses when the live strategy no longer hashes to it. Absent on rows
   *  queued before ADR 0845 (status-only legacy compare). */
  strategyContentDigest?: string;
  /** ADR 0845 D5 — the CANONICAL submitter (a delegated key's issuer, else the
   *  subject). The decide handler refuses self-approval when another approver
   *  exists. Absent on legacy rows. A data subject: redacted on erasure. */
  strategyRequestedBy?: string;
  /** ADR 0924 D1 — `campaign-change-set`: the change set an approval names, and
   *  ONLY that one. `orgId` carries the client org. Opaque to core; the
   *  campaign-ops feature owns the checks (hash, request version, asset versions). */
  changeSetId?: string;
  changeSetHash?: string;
  changeSetRequestId?: string;
  changeSetRequestVersion?: number;
  /** assetId → the source identity the change set was built against. */
  changeSetSourceVersions?: Record<string, { version: number; contentHash: string }>;
  /** The member who caused the proposal (separation of duties). A data subject. */
  changeSetProposedBy?: string;
  /** ADR 0959 D7 — `playbook-rollout`: the rollout an approval names and the plan hash
   *  the approver saw. `orgId` is the workspace ROOT (agency admins decide). Opaque to
   *  core; the campaign-playbooks feature owns the checks (re-plan, separation of duties). */
  playbookRolloutId?: string;
  playbookId?: string;
  playbookRolloutPlanHash?: string;
  /** The agency admin who requested the rollout (separation of duties). A data subject. */
  playbookRolloutRequestedBy?: string;
  /** The board card the proposal originated from (the "cited source"). */
  boardId?: string;
  cardId?: string;
  cardTitle?: string;
  /** Human-readable one-liner, e.g. "Run intake-triage on 'New family: Garcia'". */
  proposal: string;
  /** ADR 0478 §3 — the AGENT'S stated reasoning for this proposal (a claim,
   *  attributed as such — never the reviewer's `note`). Sanitized, capped. */
  reasoning?: string;
  status: ApprovalStatus;
  createdAt: string;
  /** Set when claimed or rejected. */
  resolvedAt?: string;
  /** The run a CLAIM started (absent until claimed). */
  runId?: string;
  /** Optional reviewer note captured at claim/reject time. */
  note?: string;
  /** ADR 0592 §8 — the deciding subject (opaque principal id), persisted at
   *  resolve so kind redactors can reach a reviewer's attribution on DSAR.
   *  Absent on legacy rows and on system/agent-resolved decisions. */
  decidedBy?: string;
  /** Multi-approver / quorum policy (ADR 0070). Absent OR `requiredApprovals <= 1`
   *  ⇒ the legacy single-decision path (a claim/reject resolves immediately).
   *  When `requiredApprovals > 1`, each claim/reject is an eligibility-checked VOTE
   *  recorded in the durable `review:decision` ledger keyed by `approvalId`; the
   *  final transition (run start / reject) fires exactly once when policy is met. */
  policy?: ApprovalPolicy;
}

export interface ApprovalPolicy {
  requiredApprovals: number;
  /** Eligible approver subject refs; empty (and no group/role refs) ⇒ any holder
   *  of `approvals:respond`. */
  approverRefs?: string[];
  /** ADR 0075 §D2 — accessControl group refs whose members are eligible. Resolved
   *  LIVE to subjects at decision time (ADR 0075 §D3), tenant/org-scoped (§D5).
   *  Host-extension only — NOT on the OpenWOP wire (interrupt-path portability is
   *  RFC 0104). */
  approverGroupRefs?: string[];
  /** ADR 0075 §D2 — accessControl role refs (built-in or custom) whose effective
   *  holders are eligible. Same live, tenant/org-scoped resolution as groups. */
  approverRoleRefs?: string[];
  /** How rejections fail the gate. Default: a single reject fails it. */
  rejectionPolicy?: 'any' | 'majority';
  /** ADR 0942 D7 — a per-row SLA ladder that overrides the tenant's (`approvalSla.ts`). Expire = reject. */
  sla?: { remindAfterMs?: number; escalateAfterMs?: number; expireAfterMs?: number };
  /** ADR 0942 D7 — who the escalate rung notifies (roles on the row's org). */
  escalateTo?: { roleRefs: string[] };
  /** ADR 0942 D7 — `false` turns ADR 0198 delegation off for this row. */
  allowDelegation?: boolean;
}

const approvals = new DurableCollection<PendingApproval>('approval', (a) => a.approvalId);

// ── tenant/status secondary index (ADR 0029, T8) ──
// `listApprovals` + `hasPendingApprovalForCard` run on EVERY heartbeat poll;
// they were full cross-tenant scans. Index ids embed (tenant, status) so the
// hot path is a bounded prefix scan; rows re-checked against the source of
// truth (stale rows tolerated, never trusted).
interface ApprovalIndexRow {
  ixId: string;
  approvalId: string;
}
const approvalsByTenantStatus = new DurableCollection<ApprovalIndexRow>('approval:by-tenant-status', (r) => r.ixId);
const approvalIxId = (tenantId: string, status: ApprovalStatus, approvalId: string): string =>
  `${tenantId}:${status}:${approvalId}`;

async function indexApproval(a: PendingApproval, prevStatus?: ApprovalStatus): Promise<void> {
  if (prevStatus !== undefined && prevStatus !== a.status) {
    await approvalsByTenantStatus.delete(approvalIxId(a.tenantId, prevStatus, a.approvalId));
  }
  await approvalsByTenantStatus.put({ ixId: approvalIxId(a.tenantId, a.status, a.approvalId), approvalId: a.approvalId });
}

/** One-time boot sweep: index approval rows written before the index existed
 *  (same discipline as `backfillCommitmentIndexes`). Without this, every
 *  pre-upgrade pending approval would vanish from the inbox and the
 *  heartbeat would re-propose cards it can no longer see as pending.
 *  Idempotent — puts are upserts. Called from app boot. */
export async function backfillApprovalIndexes(): Promise<number> {
  const all = await approvals.list();
  for (const a of all) await indexApproval(a);
  return all.length;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Per-approval in-process serialization. The durable store has no
// compare-and-swap, so two concurrent resolves could each read `pending` before
// either writes. Chaining each key's work serializes resolves within one
// process → exactly one winner. (Cross-INSTANCE races still need the
// conditional-write a production host provides; documented on resolveApproval.)
const resolveChains = new Map<string, Promise<unknown>>();
function withApprovalLock<T>(approvalId: string, fn: () => Promise<T>): Promise<T> {
  const prior = resolveChains.get(approvalId) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  resolveChains.set(approvalId, tail);
  // Drop the entry once this is the last queued work for the key (bounds the map).
  void tail.then(() => {
    if (resolveChains.get(approvalId) === tail) resolveChains.delete(approvalId);
  });
  return run;
}

export async function createApproval(input: {
  tenantId: string;
  rosterId: string;
  persona: string;
  workflowId: string;
  boardId?: string;
  cardId?: string;
  cardTitle?: string;
  conversationId?: string;
  configurable?: Record<string, unknown>;
  scheduleJobId?: string;
  proposal: string;
  /** Multi-approver / quorum policy (ADR 0070). Omit for the single-decision gate. */
  policy?: ApprovalPolicy;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: input.rosterId,
    persona: input.persona,
    workflowId: input.workflowId,
    conversationId: input.conversationId,
    configurable: input.configurable,
    boardId: input.boardId,
    cardId: input.cardId,
    cardTitle: input.cardTitle,
    proposal: input.proposal,
    ...(input.scheduleJobId ? { scheduleJobId: input.scheduleJobId } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * Create the approval act for an Executive-Assistant outbound action
 * (ADR 0023 §12 T4). Same durable queue + CAS resolve as run proposals —
 * the assistant is one more proposer on the single loop, attributed to its
 * chief-of-staff identity rather than a board card.
 */
export async function createAssistantActionApproval(input: {
  tenantId: string;
  actionId: string;
  /** The action kind + a one-line summary, e.g. `email.send: "Re: Q3 numbers" to dana@…`. */
  proposal: string;
  /** The REAL Chief-of-Staff roster member this approval is attributed to
   *  (ADR 0023, corrected 2026-06-11). The caller resolves it via
   *  `ensureChiefOfStaff(tenantId)`; this used to be a literal `'assistant'`
   *  pseudo-id that resolved to no RosterEntry (the parallel-architecture bug). */
  rosterId: string;
  persona: string;
  /** ADR 0878 D6 — the org the action belongs to (a support reply's ticket org).
   *  Drives `APPROVAL_AUDIENCE['assistant-action']`'s `orgScopeWhenOrg`; absent ⇒
   *  tenant-wide, exactly as before. */
  orgId?: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: input.rosterId,
    persona: input.persona,
    workflowId: '',
    actionId: input.actionId,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    kind: 'assistant-action',
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * ADR 0785 P4 — file a Claude Code permission prompt as an approval in the ONE
 * queue (ADR 0025 §4). `ownerSubject` is the device's human: the sole approver
 * and the visibility key (the `kicktodo-plan-proposal` audience shape).
 * `workflowId` is empty, as for the other non-run kinds.
 */
export async function createClaudeCodePermissionApproval(input: {
  tenantId: string;
  ownerSubject: string;
  permission: NonNullable<PendingApproval['claudeCodePermission']>;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '',
    persona: 'Claude Code',
    workflowId: '',
    kind: 'claude-code-permission',
    proposal: input.permission.summary.slice(0, 500), // already "<tool> — <detail>"
    claudeCodePermission: input.permission,
    policy: { requiredApprovals: 1, approverRefs: [input.ownerSubject] },
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * The assistant-action decision handler, registered by the assistant FEATURE
 * at boot (core owns the hook; the feature depends on core, never the
 * reverse — the `connectionInjection`/`featureSurfaces` discipline). The
 * approvals routes call this for `actionId`-carrying approvals so the claim
 * path and the assistant's own approve/reject route share ONE implementation.
 */
export type AssistantActionDecision = {
  approval: PendingApproval;
  /** The updated PendingAction row, host-shaped (projected by the feature). */
  action: Record<string, unknown> | null;
  changed: boolean;
};
export type AssistantActionApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  /** ADR 0862 D1 — the content hash the approver's card displayed; required on approve. */
  opts: {
    decidedByUserId?: string; note?: string; expectedContentHash?: string;
    /** ADR 0878 D6 — who is deciding, for an org-scoped action's check. */
    decider?: { spellings: string[]; isOperator?: boolean; isPersonalOwner?: boolean };
  },
) => Promise<AssistantActionDecision | null>;

let actionApprovalHandler: AssistantActionApprovalHandler | null = null;

export function registerAssistantActionApprovalHandler(fn: AssistantActionApprovalHandler): void {
  actionApprovalHandler = fn;
}

export function getAssistantActionApprovalHandler(): AssistantActionApprovalHandler | null {
  return actionApprovalHandler;
}

/**
 * Projector for an assistant-action's rich card metadata (risk tier, reason,
 * source citations, recipient diff, taint, draft). Registered by the assistant
 * FEATURE at boot — core's approvals LIST route calls it to embed the typed
 * PendingAction onto each `actionId`-carrying approval row so the inbox can
 * render the rich ActionCard, WITHOUT core importing the feature (direction:
 * feature → core only). Returns a host-shaped row (internal columns projected
 * out) or null when the action is missing/cross-tenant. */
export type AssistantActionProjector = (
  tenantId: string,
  actionId: string,
  /** ADR 0862 (grade-code) — WHO is reading. The card carries the drafted outbound body,
   *  its recipients and the event it will send; the feature withholds those from a reader
   *  without its write authority (COS-11: "a viewer must not read a draft they cannot
   *  send"). The two request-level exits are threaded, because the predicate is a
   *  `(tenant, subject)` function that cannot see them. Absent ⇒ an internal caller. */
  viewer?: AssistantActionViewer,
) => Promise<Record<string, unknown> | null>;

export interface AssistantActionViewer {
  subject?: string;
  isOperator?: boolean;
  isPersonalOwner?: boolean;
}

let actionProjector: AssistantActionProjector | null = null;

export function registerAssistantActionProjector(fn: AssistantActionProjector): void {
  actionProjector = fn;
}

export function getAssistantActionProjector(): AssistantActionProjector | null {
  return actionProjector;
}

/**
 * Create a campaign ad-spend approval (campaign gap plan §5B B3). Same durable
 * queue + CAS resolve as every other proposer — NOT a second approval store.
 * No agent, no run: the ads adapter (host/adsAdapter.ts) creates it when a live
 * dispatch/budget-set meets the tenant spend threshold, and re-checks it (by
 * `spendIdemKey`) on the next attempt — approve, then re-run, and the spend
 * proceeds. Amounts + ids only; never creative bytes or credentials.
 */
/** ADR 0415 D3 — the Challenge Factory publication gate (one queue, one inbox). */
export async function createChallengePublishApproval(input: {
  tenantId: string;
  proposal: string;
  candidateId: string;
  challengeId: string;
  challengeVersion: number;
  submittedBy: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: 'host:kicktodo-factory',
    persona: 'Challenge Factory',
    workflowId: 'openwop-app.kicktodo.publish',
    proposal: input.proposal,
    kind: 'challenge-publish',
    challengePublish: {
      candidateId: input.candidateId,
      challengeId: input.challengeId,
      challengeVersion: input.challengeVersion,
      submittedBy: input.submittedBy,
    },
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/** ADR 0426 — community moderation approvals: `community-profile` gates a
 *  creator profile's public visibility; `community-review` resolves a flagged
 *  challenge review. Payload is the opaque ref; resolution identity rules
 *  (separation of duties) are enforced by the community service. */
export async function createCommunityApproval(input: {
  tenantId: string;
  kind: 'community-profile' | 'community-review' | 'metrics-verifier-sample';
  proposal: string;
  refId: string;
  submittedBy: string;
  /** KTENG-3 / KTX-5 — a caller that has already CLAIMED a durable row naming
   *  this approval passes the id it claimed, so the row and the approval agree.
   *  Omitted ⇒ a fresh random id (unchanged behaviour). */
  approvalId?: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: input.approvalId ?? `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: 'host:kicktodo-community',
    persona: 'KickTodo Community',
    workflowId: 'openwop-app.kicktodo.community',
    proposal: input.proposal,
    kind: input.kind,
    community: { refId: input.refId, submittedBy: input.submittedBy },
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/** ADR 0445 D2 — the connect-seller request act: an author asks the operator
 *  for payout onboarding. Same durable queue + CAS resolve as every other gate. */
export async function createConnectSellerApproval(input: {
  tenantId: string;
  proposal: string;
  submittedBy: string;
  /** KTM-3 — a caller-derived DETERMINISTIC id makes the create idempotent: the
   *  first create wins (insert-if-absent) and every later create with the same id
   *  returns that row instead of minting a second inbox card. Omitted ⇒ a random
   *  id, unchanged. */
  approvalId?: string;
}): Promise<PendingApproval> {
  if (input.approvalId !== undefined) {
    const prior = await approvals.get(input.approvalId);
    if (prior) return prior;
  }
  const approval: PendingApproval = {
    approvalId: input.approvalId ?? `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: 'host:kicktodo-commerce',
    persona: 'KickTodo Commerce',
    workflowId: 'openwop-app.kicktodo.commerce',
    proposal: input.proposal,
    kind: 'connect-seller',
    connectSeller: { submittedBy: input.submittedBy },
    status: 'pending',
    createdAt: nowIso(),
  };
  if (input.approvalId !== undefined) {
    if (!(await approvals.compareAndSwap(null, approval))) {
      const winner = await approvals.get(approval.approvalId);
      if (winner) return winner; // a concurrent create with the same id won
      throw new Error(`connect-seller approval ${approval.approvalId} could not be created.`);
    }
  } else {
    await approvals.put(approval);
  }
  await indexApproval(approval);
  return approval;
}

/**
 * ADR 0554 P2 / RFC 0151 §E — raise the approval gate for ONE inverse effect.
 *
 * Same durable queue, inbox and CAS resolve as every other gate — "no second
 * approval store" (ADR 0025 §4), which matters more here than usual: the whole
 * point of §E is that a compensating effect passes through the SAME human gate
 * a forward effect would, so a parallel queue would defeat it by construction.
 *
 * No agent proposed this: the executor did. `rosterId` carries the host marker
 * rather than a roster member so the card cannot be mistaken for an agent
 * proposal an operator could redirect.
 */
export async function createCompensationApproval(input: {
  tenantId: string;
  runId: string;
  workflowId: string;
  compensationId: string;
  nodeId?: string;
  compensationNodeTypeId: string;
  requestedBy?: string;
  proposal: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: 'host:compensation',
    persona: 'Compensation',
    workflowId: input.workflowId,
    proposal: input.proposal,
    kind: 'compensation-action',
    compensationAction: {
      runId: input.runId,
      compensationId: input.compensationId,
      ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
      compensationNodeTypeId: input.compensationNodeTypeId,
      ...(input.requestedBy !== undefined ? { requestedBy: input.requestedBy } : {}),
    },
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * ADR 0459 P2 — raise a KickTodo coach plan-change proposal as an approval card.
 * Same durable queue + CAS resolve as every other gate. No agent, no run:
 * `rosterId`/`persona`/`workflowId` are empty; the decide path is
 * `kicktodo-accountability`'s registered handler, which calls `resolveProposal`
 * (the ONE applier). The DECIDER is the participant — carried in
 * `policy.approverRefs[0]` (which is also the participant-only visibility key,
 * so the coach's free-text note never surfaces in another member's reviews rail).
 * `conversationId` is the circle's conversation so the card renders in-thread.
 */
export async function createKicktodoPlanProposalApproval(input: {
  tenantId: string;
  conversationId: string;
  circleId: string;
  enrollmentId: string;
  proposalId: string;
  coachSubject: string;
  participantSubject: string;
  note: string;
  proposal: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    conversationId: input.conversationId,
    kind: 'kicktodo-plan-proposal',
    planProposal: {
      circleId: input.circleId,
      enrollmentId: input.enrollmentId,
      proposalId: input.proposalId,
      coachSubject: input.coachSubject,
      note: input.note,
    },
    proposal: input.proposal,
    // requiredApprovals:1 keeps the legacy single-decision path (no quorum badge);
    // approverRefs names the participant as the sole decider AND the visibility key.
    policy: { requiredApprovals: 1, approverRefs: [input.participantSubject] },
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * The plan-proposal decision handler, registered by the KICKTODO-ACCOUNTABILITY
 * feature at boot (core owns the hook; the feature depends on core — the
 * content-publish discipline). The core decide path dispatches here for
 * `kind: 'kicktodo-plan-proposal'` in BOTH the claim and reject paths. The
 * handler delegates to `resolveProposal`, whose enrollment-owner check is the
 * authority — it never bypasses it (the deciding subject is passed through).
 */
export type PlanProposalApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let planProposalApprovalHandler: PlanProposalApprovalHandler | null = null;

export function registerPlanProposalApprovalHandler(fn: PlanProposalApprovalHandler): void {
  planProposalApprovalHandler = fn;
}

export function getPlanProposalApprovalHandler(): PlanProposalApprovalHandler | null {
  return planProposalApprovalHandler;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR 0464 — subject-erasure redactor registry (generalizing the #2322/ADR 0459
// kind-local plan-proposal ops below into a store-wide seam).
//
// The approvals store carries subject identifiers + subject-authored free text in
// per-kind payload fields and has NO age-out for pending rows, so a DSAR-erased
// subject's data would survive here indefinitely without a dedicated eraser. Each
// approval kind (or its owning feature) registers a redactor describing WHICH
// payload paths carry the subject and HOW erasure treats them; ONE store-level
// `SubjectEraser` walks pending + resolved approvals and applies the registered
// redactors. New subject-bearing kinds register a map instead of hand-writing a
// bespoke eraser (the class-cure the ADR is after).
// ─────────────────────────────────────────────────────────────────────────────

/** The marker an anonymized id / redacted free-text field is replaced with. */
export const ERASED_SUBJECT_SENTINEL = '[erased]';

/** Back-compat alias — the ADR 0459 plan-proposal sentinel, now the shared one. */
export const PLAN_PROPOSAL_ERASED_NOTE = ERASED_SUBJECT_SENTINEL;

/** How a subject's data is scrubbed from one approval KIND's payload. */
export interface ApprovalKindRedactor {
  /** Dot-paths to subject-identifier fields. The subject MATCHES the row when it
   *  equals any of these; a matched row's ids (unless `preserveMatchedIds`) and
   *  `textFields` are then redacted to the sentinel. */
  idFields: string[];
  /** Dot-paths to subject-authored free text, redacted to the sentinel when the
   *  row matches on an id field. */
  textFields: string[];
  /** Match on the id fields but do NOT anonymize them — used where the id is a
   *  structural match key whose PII lives in the text (kicktodo-plan-proposal:
   *  `coachSubject` is the match key; the coach's free-text note is the PII). This
   *  keeps the #2322 behavior byte-identical. */
  preserveMatchedIds?: boolean;
  /** How a subject appearing in this kind's approver refs is handled. Default
   *  'anonymize' (the ref → sentinel; the list length, and thus the quorum shape,
   *  is preserved). 'delete' removes the whole row — used where the approver IS
   *  the data subject and the card is meaningless once they are erased
   *  (kicktodo-plan-proposal: the participant is the sole decider). This is the
   *  ADR's `mode: 'delete-when-subject-is-<role>'`. */
  onApproverMatch?: 'anonymize' | 'delete';
  /** ADR 0469 OD4 — how a subject appearing in an ID FIELD (not an approver ref) is
   *  handled beyond redaction. 'cancel' additionally flips a still-PENDING row to
   *  `rejected` (moving the status index) — used where the id-subject is the
   *  REQUESTER and a pending action must not later execute for an erased subject
   *  (`anon-surface-write`: the anon principal is the visitor whose held write must
   *  never run once they are gone). A resolved row is redacted but its terminal
   *  status is untouched (it stays an audit record). Default: redact only. */
  onSubjectMatch?: 'cancel';
}

const approvalRedactors = new Map<string, ApprovalKindRedactor>();

/** Register (or replace) the redactor for one approval kind. Idempotent by kind.
 *  Called at module load for built-in kinds, and by the owning feature for its
 *  own kind (kicktodo-accountability registers `kicktodo-plan-proposal`). */
export function registerApprovalRedactor(kind: string, redactor: ApprovalKindRedactor): void {
  approvalRedactors.set(kind, redactor);
}

// ── Per-kind decider ELIGIBILITY (KTFULL-B2 approvals-side half) ─────────────
//
// The decision lane (claim/reject/vote — routes, review cards, decide-by-email)
// resolves any pending approval for any identified caller unless the kind's
// OWNER registers a check here. This closes the "a scope-holding second identity
// can still resolve" gap: the owner states WHO may decide its kind (authority +
// separation-of-duties), enforced at the ONE decision choke before any handler
// or vote records. Direct feature-route paths (e.g. complete-publication) keep
// their own gates; this covers the generic lane those gates never see.

/** Throws OpenwopError (403) when `decidedBy` may not decide this approval.
 *
 *  `opts.isOperator` carries the request-level wildcard-operator / superadmin
 *  escape (`isSuperadmin(req)` — env API key, admin tooling, the conformance
 *  harness). It has to be THREADED rather than re-derived: a check receives a
 *  tenant and a subject, not a Request, so without it every kind-level gate
 *  silently revokes an escape the ROUTES grant — which is a different bug in
 *  the opposite direction, and a real one (added UX_UPGRADE-assistant R2, after
 *  the assistant's new gate 403'd the bearer-authed admin lane). */
export type ApprovalEligibilityCheck = (
  tenantId: string,
  decidedBy: string | undefined,
  approval: PendingApproval,
  /** `spellings` (ADR 0878): every spelling of the decider, for a kind whose check is
   *  a membership lookup — one human can be keyed two ways (`callerSubjectSpellings`). */
  opts?: { isOperator?: boolean; isPersonalOwner?: boolean; spellings?: string[] },
) => Promise<void>;

const eligibilityChecks = new Map<string, ApprovalEligibilityCheck>();

/** Register (or replace) the decider-eligibility check for one approval kind.
 *  Called by the OWNING feature at boot (the redactor-registry inversion). */
export function registerApprovalEligibility(kind: string, check: ApprovalEligibilityCheck): void {
  eligibilityChecks.set(kind, check);
}

/** Enforce the kind's registered eligibility check (no-op for kinds without one
 *  — their authorization lives in their own dispatch handlers/routes). */
export async function assertApprovalEligibility(
  tenantId: string,
  decidedBy: string | undefined,
  approval: PendingApproval,
  opts?: { isOperator?: boolean; isPersonalOwner?: boolean; spellings?: string[] },
): Promise<void> {
  const check = approval.kind ? eligibilityChecks.get(approval.kind) : undefined;
  if (check) await check(tenantId, decidedBy, approval, opts);
}

/** APPR-5 — the kinds that currently have a registered redactor. The
 *  redactor-completeness test asserts this covers every `APPROVAL_KINDS` entry
 *  (built-ins registered at module load; feature-owned kinds at feature boot),
 *  so a NEW subject-carrying kind added without a redactor fails the test. */
export function getRegisteredApprovalRedactorKinds(): string[] {
  return [...approvalRedactors.keys()];
}

/** Read a dot-path (max two levels here: `planProposal.note`). */
function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

/** Immutably set a dot-path, returning a NEW object down the touched spine only
 *  (a missing intermediate is a no-op — returns the input unchanged). */
function setPath<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  if (rest.length === 0) return { ...obj, [head!]: value };
  const child = (obj as Record<string, unknown>)[head!];
  if (!child || typeof child !== 'object') return obj;
  return { ...obj, [head!]: setPath(child, rest.join('.'), value) };
}

/** The three approver-ref lists on an approval's policy, in one place. */
function approverRefLists(a: PendingApproval): (readonly string[])[] {
  return [
    a.policy?.approverRefs ?? [],
    a.policy?.approverGroupRefs ?? [],
    a.policy?.approverRoleRefs ?? [],
  ];
}

/** Anonymize the subject wherever it appears in any approver-ref list, preserving
 *  each list's length (so the quorum/eligibility shape is unchanged). Returns the
 *  same reference when the subject is absent (a clean dirty-check). Matches every
 *  subject-key FORM (raw + scoped) — the DSAR entry point accepts either. */
function anonymizeApproverRefs(a: PendingApproval, subjectForms: ReadonlySet<string>): PendingApproval {
  if (!a.policy) return a;
  const scrub = (arr?: string[]): string[] | undefined =>
    arr?.map((r) => (subjectForms.has(r) ? ERASED_SUBJECT_SENTINEL : r));
  const hit = approverRefLists(a).some((list) => list.some((r) => subjectForms.has(r)));
  if (!hit) return a;
  return {
    ...a,
    policy: {
      ...a.policy,
      ...(a.policy.approverRefs ? { approverRefs: scrub(a.policy.approverRefs)! } : {}),
      ...(a.policy.approverGroupRefs ? { approverGroupRefs: scrub(a.policy.approverGroupRefs)! } : {}),
      ...(a.policy.approverRoleRefs ? { approverRoleRefs: scrub(a.policy.approverRoleRefs)! } : {}),
    },
  };
}

/**
 * The reusable per-subject walk (optionally restricted to a single kind). For
 * every tenant approval whose registered redactor matches the subject:
 *   - `onApproverMatch: 'delete'` + subject ∈ approver refs → delete the row AND
 *     its `(tenant, status)` index entry (mirrors `deleteApprovalsForRoster`);
 *   - id-field match → redact the matched ids (unless `preserveMatchedIds`) and
 *     the declared free-text fields to the sentinel, status + key untouched (a
 *     pending card stays decidable, no index churn);
 *   - subject ∈ approver refs (non-delete kinds) → anonymize the matching refs.
 * Tenant-scoped, idempotent (re-running finds fields already at the sentinel /
 * rows already gone and no-ops), no notifications. Returns the count touched.
 */
async function applyApprovalRedactorsForSubject(
  tenantId: string,
  subject: string,
  opts: { onlyKind?: string } = {},
): Promise<number> {
  if (!tenantId || !subject) return 0;
  // Match every subject-key form (raw `alice` + scoped `user:alice`): the DSAR
  // entry point accepts either, while these rows store the raw principal.
  const { forms } = subjectKeyForms(subject);
  let touched = 0;
  for (let a of await listApprovals(tenantId)) {
    const kind = a.kind ?? 'run-proposal';
    if (opts.onlyKind && kind !== opts.onlyKind) continue;

    // ADR 0592 §8 correction (review F2) — `decidedBy` is a UNIVERSAL row
    // field (persisted by `resolveApproval` for EVERY kind), so its redaction
    // is kind-INDEPENDENT and runs before the per-kind map: when the erased
    // subject is the decider, their attribution AND their authored reviewer
    // `note` are redacted on any kind, registered redactor or not. The first
    // draft redacted it only on content-publish via per-kind idFields — the
    // my-fix-reintroduces-the-family shape: the new field would have survived
    // DSAR on every other kind.
    if (typeof a.decidedBy === 'string' && forms.has(a.decidedBy)) {
      const redacted: PendingApproval = {
        ...a,
        decidedBy: ERASED_SUBJECT_SENTINEL,
        ...(a.note !== undefined && a.note !== ERASED_SUBJECT_SENTINEL ? { note: ERASED_SUBJECT_SENTINEL } : {}),
      };
      await approvals.put(redacted);
      touched += 1;
      // Continue the walk over the UPDATED row so per-kind logic still applies.
      a = redacted;
    }

    const redactor = approvalRedactors.get(kind);
    if (!redactor) continue;

    const approverHit = approverRefLists(a).some((list) => list.some((r) => forms.has(r)));

    // Delete escalation: the approver IS the erased subject and the kind says the
    // card is meaningless without them.
    if (approverHit && redactor.onApproverMatch === 'delete') {
      await approvals.delete(a.approvalId);
      await approvalsByTenantStatus.delete(approvalIxId(tenantId, a.status, a.approvalId));
      touched += 1;
      continue;
    }

    let next = a;
    let changed = false;

    // Id-field match → redact this row's ids + declared text.
    // ADR 0859 D3 — an id field may be a LIST of subjects (`submitters`): it hits when
    // any element does, and only the matching elements are replaced.
    const fieldHit = (v: unknown): boolean => (typeof v === 'string' && forms.has(v))
      || (Array.isArray(v) && v.some((x) => typeof x === 'string' && forms.has(x)));
    const redactId = (v: unknown): unknown => (Array.isArray(v)
      ? v.map((x) => (typeof x === 'string' && forms.has(x) ? ERASED_SUBJECT_SENTINEL : x))
      : ERASED_SUBJECT_SENTINEL);
    const idMatched = redactor.idFields.some((p) => fieldHit(getPath(a, p)));
    if (idMatched) {
      if (!redactor.preserveMatchedIds) {
        for (const p of redactor.idFields) {
          const cur = getPath(next, p);
          if (fieldHit(cur)) { next = setPath(next, p, redactId(cur)); changed = true; }
        }
      }
      for (const p of redactor.textFields) {
        const cur = getPath(next, p);
        if (cur !== undefined && cur !== ERASED_SUBJECT_SENTINEL) {
          next = setPath(next, p, ERASED_SUBJECT_SENTINEL);
          changed = true;
        }
      }
    }

    // Approver-ref anonymize (non-delete kinds).
    if (approverHit) {
      const before = next;
      next = anonymizeApproverRefs(next, forms);
      if (next !== before) changed = true;
    }

    // ADR 0469 OD4 — `onSubjectMatch:'cancel'`: when the ERASED subject is this
    // row's id-subject and the row is still PENDING, flip it to `rejected` so the
    // held action can never later execute for a gone subject. A resolved row keeps
    // its terminal status (audit). The status-index move mirrors `resolveApproval`.
    if (idMatched && redactor.onSubjectMatch === 'cancel' && next.status === 'pending') {
      const prevStatus = next.status;
      next = { ...next, status: 'rejected' };
      await approvals.put(next);
      await indexApproval(next, prevStatus);
      touched += 1;
      continue;
    }

    if (changed) { await approvals.put(next); touched += 1; }
  }
  return touched;
}

/**
 * ADR 0878 D4 — redact ONE approval's free-text `proposal` (it quotes the drafted
 * action) and cancel it if still pending, so the held action can never execute for
 * an erased requester. For a caller that already knows which approval carries the
 * erased person's words (the service-desk eraser follows a ticket's drafted
 * replies) — the kind redactors match on subject refs, and a support reply's
 * proposal carries none. Idempotent. Returns true when the row changed.
 */
export async function redactApprovalProposal(
  tenantId: string,
  approvalId: string,
  /** KTFAC-3 (KickTodo wave 4C) — `cancelPending: false` redacts the text only, for
   *  a card whose action must still be decidable after the quoted author is erased
   *  (a challenge publish: the challenge is authored content and stays). Default
   *  true — the ADR 0878 D4 behaviour, unchanged for existing callers. */
  opts: { cancelPending?: boolean } = {},
): Promise<boolean> {
  const a = await approvals.get(approvalId);
  if (!a || a.tenantId !== tenantId) return false;
  const cancel = opts.cancelPending ?? true;
  const status: ApprovalStatus = cancel && a.status === 'pending' ? 'rejected' : a.status;
  if (a.proposal === ERASED_SUBJECT_SENTINEL && status === a.status) return false;
  const next: PendingApproval = { ...a, proposal: ERASED_SUBJECT_SENTINEL, status };
  await approvals.put(next);
  await indexApproval(next, a.status);
  return true;
}

/**
 * ADR 0464 — the ONE store-level `SubjectEraser` for the approvals store. Applies
 * every registered kind redactor to the subject across pending + resolved rows.
 */
export async function eraseApprovalSubject(tenantId: string, subjectKey: string): Promise<number> {
  return applyApprovalRedactorsForSubject(tenantId, subjectKey);
}
/** ADR 0464 — called from `registerHostSubjectErasers()` (one explicit boot list). */
export function registerApprovalErasure(): void {
  registerSubjectEraser(async function eraseApprovals(tenantId, subjectKey) { await eraseApprovalSubject(tenantId, subjectKey); });
}

/**
 * ADR 0469 OQ2 — auto-expire NEVER-DECIDED anon-surface-write holds. An anonymous
 * visitor never returns, so a pending hold from a gone visitor would otherwise
 * linger forever carrying their PII (`captured*` / `tool.args`). Delete pending
 * `anon-surface-write` rows whose `createdAt` is older than the confidential-pii
 * retention cutoff (their TTL is that EXISTING operator setting — the rows are
 * PII-bearing, so `confidential-pii` is their honest classification; no new knob).
 * ONLY pending rows: a decided hold is an audit record kept on its own window.
 * Tenant-scoped + resilient (via `purgeRowsByAge`); the pending status-index entry
 * is dropped with each row. Returns the count deleted.
 */
export async function purgeExpiredAnonHolds(tenantId: string, cutoffIso: string): Promise<PurgeOutcome> {
  // Index-scoped read (by-tenant-status), NOT a full cross-tenant `approvals.list()`
  // scan — the retention daemon calls this per (tenant, classification).
  const rows = (await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'anon-surface-write');
  return purgeRowsByAge(
    'approvals',
    rows,
    tenantId,
    cutoffIso,
    (a) => ({ tenantId: a.tenantId, updatedAt: a.createdAt, id: a.approvalId }),
    async (id) => {
      await approvals.delete(id);
      await approvalsByTenantStatus.delete(approvalIxId(tenantId, 'pending', id));
    },
  );
}

// ADR 0469 OQ2 — self-register the anon-hold TTL purger on the ONE retention seam
// (module-load, mirroring `capsTracker`). Fires only for the confidential-pii window.
registerRetentionPurger({
  feature: 'approvals',
  async purge(tenantId, classification, cutoffIso) {
    if (classification !== 'confidential-pii') return 0;
    return purgeExpiredAnonHolds(tenantId, cutoffIso);
  },
});

// ── Built-in kind redactors (the audited per-kind field maps, ADR 0464 §2.3) ──
// Submission kinds: the SUBMITTER is a data subject; redact their id + proposal.
registerApprovalRedactor('challenge-publish', { idFields: ['challengePublish.submittedBy'], textFields: ['proposal'] });
registerApprovalRedactor('community-profile', { idFields: ['community.submittedBy'], textFields: ['proposal'] });
registerApprovalRedactor('community-review', { idFields: ['community.submittedBy'], textFields: ['proposal'] });
registerApprovalRedactor('metrics-verifier-sample', { idFields: ['community.submittedBy'], textFields: ['proposal'] });
registerApprovalRedactor('connect-seller', { idFields: ['connectSeller.submittedBy'], textFields: ['proposal'] });
// assistant-action + text-only kinds: NO first-party subject-id field in the
// KIND-SPECIFIC payload, so a per-kind subject match can never fire — the
// erasure this seam performs for these kinds is approver-ref anonymization
// (which needs no field map) plus the UNIVERSAL `decidedBy`/`note` redaction
// in the walk itself (ADR 0592 §8 correction, review F2 — `decidedBy` is
// persisted on every resolved row since ADR 0592, so the old "no first-party
// subject data" phrasing here was falsified by that change). `textFields` is deliberately EMPTY: the `proposal` free text may carry
// third-party PII (e.g. assistant-action often quotes a recipient's cleartext
// email), but an erasure subject key (`user:<id>`) cannot be matched to an email
// string inside prose, and scrubbing the proposal when the APPROVER is erased
// would destroy audit text that is not the approver's data. KNOWN RESIDUAL
// (ADR 0464 implementation record): third-party PII inside `proposal` text is
// out of this seam's reach; tenant teardown and any future approvals retention
// are the backstop. The other ids on these rows are third-party CRM contact
// records (contact-merge — erased by the CRM feature per its retention
// precedent) or tenant refs (page/order/strategy ids); the proposing agent's
// `rosterId` (run-proposal) is agent identity handled by `deleteApprovalsForRoster`.
for (const k of ['assistant-action', 'run-proposal', 'contact-merge', 'commerce-spend', 'warehouse-load'] as const) {
  registerApprovalRedactor(k, { idFields: [], textFields: [] });
}
// ADR 0859 D3 — a content-publish row now records who SUBMITTED it (separation of
// duties + the decision notice). A subject list, so the walk redacts per element.
registerApprovalRedactor('content-publish', { idFields: ['submitters', 'submitterCauses'], textFields: [] });
// ADR 0942 D10.2 — an autonomy-gated spend row records the run's requesters (subject ids).
registerApprovalRedactor('campaign-spend', { idFields: ['submitters', 'submitterCauses'], textFields: [] });
registerApprovalRedactor('creative-publish-review', { idFields: ['submitters'], textFields: [] }); // ADR 0945 × 0942
// ADR 0845 D5 — a strategy activation now records its SUBMITTER (a subject id) for the
// separation-of-duties check; it is erased like every other subject ref.
// ADR 0905 D3 — the submitters are subject ids; the pinned subject/body is template
// copy (not subject data) and the approver refs are scrubbed with every `policy`.
registerApprovalRedactor('email-campaign-send', { idFields: ['submitters', 'submitterCauses'], textFields: [] });
registerApprovalRedactor('funnel-publish', { idFields: ['submitters', 'submitterCauses'], textFields: [] });
registerApprovalRedactor('strategy-activation', { idFields: ['strategyRequestedBy'], textFields: [] });
registerApprovalRedactor('campaign-change-set', { idFields: ['changeSetProposedBy'], textFields: [] }); // ADR 0924
registerApprovalRedactor('playbook-rollout', { idFields: ['playbookRolloutRequestedBy'], textFields: [] }); // ADR 0959
// ADR 0473 — composed-workflow: the proposer is an AGENT (agentProfileId — not a
// data subject), but the PROPOSAL originates from a human conversation:
// `composedWorkflow.proposedByUserId` records that acting user (grade-data H1
// — the previous registration declared `textFields: ['proposal']` with EMPTY
// `idFields`, which never matches: structurally dead code that silently
// skipped every erasure). On that user's erasure the id is sentinel'd and
// `proposal` + `reasoning` (ADR 0478 agent prose composed from the
// conversation) are redacted. KNOWN RESIDUAL (the assistant-action precedent
// above): `runInputs` is structured agent-authored config that may embed user
// prose — a subject key cannot be matched inside arbitrary JSON, and
// sentinel-replacing the object would corrupt the row; legacy rows lacking
// `proposedByUserId` also stay out of reach. Tenant teardown and approvals
// retention are the backstop.
registerApprovalRedactor('composed-workflow', { idFields: ['composedWorkflow.proposedByUserId'], textFields: ['proposal', 'reasoning'] });
// CHAT-FIRST-PORT-AUDIT D3 — strategy-checkin / pm-scenario-select carry only
// tenant refs (strategy/check-in/list/session/scenario ids), no first-party data
// subject id; approver-ref anonymization needs no field map. Empty, like above.
for (const k of ['strategy-checkin', 'pm-scenario-select'] as const) {
  registerApprovalRedactor(k, { idFields: [], textFields: [] });
}
// CFP-1 (D9) field-sales kinds. dealer-registration / territory-model-transition
// carry only tenant refs (regId/dealerId/modelId) + B2B deal text — no first-party
// data subject, so an empty map (approver-ref anonymize only, like content-publish).
// commission-statement DOES carry a rep subject (`subjectId`): a DSAR erasing that
// rep redacts the id + the proposal free-text on the pending/resolved card.
registerApprovalRedactor('dealer-registration', { idFields: [], textFields: [] });
registerApprovalRedactor('territory-model-transition', { idFields: [], textFields: [] });
registerApprovalRedactor('commission-statement', { idFields: ['commissionStatement.subjectId'], textFields: ['proposal'] });
// ADR 0385 (chat-first-port F3) — commerce-listing-publish carries only tenant +
// pack refs (packName / sellerTenantId are a pack id + a tenant id, not a data
// subject), so an empty map (approver-ref anonymize only, like content-publish).
registerApprovalRedactor('commerce-listing-publish', { idFields: [], textFields: [] });
// ADR 0469 — the opaque anon `principal` is the match key (NOT PII → preserved); the
// captured visitor fields are the PII, redacted flat (the 2-level getPath reaches them).
// ADR 0469 OD4 — the anon principal is the erased subject; redact it, the captured
// lead fields, AND the visitor-supplied `tool.args`/`destination` (a public visitor
// can type PII into a write argument — the nested object is reachable by the
// depth-capable getPath/setPath). `onSubjectMatch:'cancel'` flips a still-pending
// hold to rejected so the (now sentinel-stringified) args can never be executed by
// A4 for a gone visitor; a resolved row stays a redacted audit record.
registerApprovalRedactor('anon-surface-write', {
  idFields: ['anonSurfaceWrite.principal'],
  textFields: ['anonSurfaceWrite.capturedName', 'anonSurfaceWrite.capturedEmail', 'anonSurfaceWrite.capturedNote', 'anonSurfaceWrite.tool.args', 'anonSurfaceWrite.tool.destination'],
  onSubjectMatch: 'cancel',
});
// ADR 0387 / H2 — environment-promotion carries only config-pointer refs
// (toEnv / fromEnv / snapshotHash), no data subject, so an empty map (approver-ref
// anonymize only, like content-publish). APPR-5: registered here so the
// completeness invariant holds — the store-wide eraser must have an entry for
// every kind, even the subjectless ones.
registerApprovalRedactor('environment-promotion', { idFields: [], textFields: [] });
// ADR 0554 P2 / RFC 0151 §E — compensation-action gates ONE inverse effect. Its
// payload is ids and type names by construction (§D/§G forbid provider bodies
// and credentials on the durable compensation path, and the approval card an
// operator reads is on that path), so nothing free-text needs scrubbing.
// `compensationAction.requestedBy` IS a subject — the human whose run committed
// the effect, and the one separation of duties is checked against — so it is
// sentinel'd on their erasure while the audit skeleton stays.
registerApprovalRedactor('compensation-action', {
  idFields: ['compensationAction.requestedBy'],
  textFields: [],
});

/**
 * ADR 0464 — the kicktodo-plan-proposal erasure, migrated onto the redactor
 * registry (behavior byte-identical to the ADR 0459 #2322 ops it replaces). The
 * kind's map is registered by `kicktodo-accountability` (it owns the kind); this
 * scoped wrapper is what the feature's own eraser invokes so plan-proposal is
 * reached even in tests that reset the erasers to only the kicktodo one. For a
 * subject who is the authoring COACH → both note copies redacted (coachSubject
 * preserved as the match key); for the deciding PARTICIPANT (approverRefs[0]) →
 * the card is deleted (row + index). A subject who is neither → no-op.
 */
export async function erasePlanProposalApprovalsForSubject(tenantId: string, subject: string): Promise<number> {
  return applyApprovalRedactorsForSubject(tenantId, subject, { onlyKind: 'kicktodo-plan-proposal' });
}

export async function createCampaignSpendApproval(input: {
  tenantId: string;
  spendKind: 'publish' | 'budget' | 'audience' | 'launch' | 'reallocation';
  platform: string;
  adAccountId: string;
  briefId?: string;
  platformCampaignId?: string;
  dailyBudgetMinor: number;
  spendIdemKey: string;
  proposal: string;
  /** Multi-approver / quorum policy (ADR 0070). Omit for the single-decision gate. */
  policy?: ApprovalPolicy;
  /** ADR 0942 — the client org whose roles the policy's approvers resolve on. */
  orgId?: string;
  /** ADR 0942 D10.2 — the run's requesters, who may not decide (no sole-approver escape). */
  submitters?: string[];
  submitterCauses?: string[];
  autonomySourceRunId?: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.submitters?.length ? { submitters: input.submitters } : {}),
    ...(input.submitterCauses?.length ? { submitterCauses: input.submitterCauses } : {}),
    ...(input.autonomySourceRunId ? { autonomySourceRunId: input.autonomySourceRunId } : {}),
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'campaign-spend',
    spendKind: input.spendKind,
    platform: input.platform,
    adAccountId: input.adAccountId,
    ...(input.briefId ? { briefId: input.briefId } : {}),
    ...(input.platformCampaignId ? { platformCampaignId: input.platformCampaignId } : {}),
    dailyBudgetMinor: input.dailyBudgetMinor,
    spendIdemKey: input.spendIdemKey,
    proposal: input.proposal,
    ...(input.policy ? { policy: input.policy } : {}),
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/** ADR 0945 × 0942 — a creative publish review, bound to a content hash. Written
 *  only by `features/campaign-orchestration/creativeReview.ts`: the deterministic
 *  immutable primary is confirmed before its binding index. Same queue and CAS resolve. */
export async function insertCreativeReviewApproval(input: {
  approvalId: string; tenantId: string; orgId: string; assetId: string; verdictId: string; reviewHash: string;
  policy: ApprovalPolicy; submitters: string[]; proposal: string;
}): Promise<PendingApproval> {
  const owned = (row: PendingApproval): boolean => row.kind === 'creative-publish-review' && row.tenantId === input.tenantId
    && row.orgId === input.orgId && row.assetId === input.assetId && row.verdictId === input.verdictId && row.reviewHash === input.reviewHash;
  const existing = await approvals.get(input.approvalId);
  if (existing) {
    if (!owned(existing)) throw new OpenwopError('conflict', 'The review identity is already in use.', 409);
    await indexApproval(existing);
    return existing;
  }
  const approval: PendingApproval = {
    approvalId: input.approvalId, tenantId: input.tenantId, orgId: input.orgId, submitters: input.submitters,
    rosterId: '', persona: '', workflowId: '', kind: 'creative-publish-review',
    assetId: input.assetId, verdictId: input.verdictId, reviewHash: input.reviewHash,
    proposal: input.proposal, policy: input.policy, status: 'pending', createdAt: nowIso(),
  };
  if (await approvals.compareAndSwap(null, approval)) {
    await indexApproval(approval);
    return approval;
  }
  const confirmed = await approvals.get(input.approvalId);
  if (!confirmed || !owned(confirmed)) throw new OpenwopError('conflict', 'The review could not be confirmed. Try again.', 409);
  await indexApproval(confirmed);
  return confirmed;
}

/** Create a commerce order/refund-value approval (ecommerce gap plan §5B B3) —
 *  the `campaign-spend` shape for the commerce thresholds. Same durable queue +
 *  CAS resolve; the commerce service re-checks by `spendIdemKey` on retry. */
export async function createCommerceSpendApproval(input: {
  tenantId: string;
  orgId: string;
  spendKind: 'order' | 'refund';
  orderId?: string;
  amountMinor: number;
  amountCurrency: string;
  spendIdemKey: string;
  proposal: string;
  policy?: ApprovalPolicy;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'commerce-spend',
    spendKind: input.spendKind,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    amountMinor: input.amountMinor,
    amountCurrency: input.amountCurrency,
    spendIdemKey: input.spendIdemKey,
    proposal: input.proposal,
    ...(input.policy ? { policy: input.policy } : {}),
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * Create a reverse-ETL warehouse-load approval (ADR 0292 / CDP-D §6) — the
 * `campaign-spend` shape for a governed BigQuery `insertAll`. Same durable queue +
 * CAS resolve; no agent, no run. The destination-sync `warehouseLoadService`
 * creates it when a load lands under the `warehouse.load` action policy
 * (default `approval-required`, fail-closed) and re-checks it (by `spendIdemKey`)
 * on the next attempt — approve, then re-run, and the insert proceeds. Ids + row
 * COUNT only; NEVER row bodies (subject data) or the BYOK credential.
 */
export async function createWarehouseLoadApproval(input: {
  tenantId: string;
  syncId: string;
  dataset: string;
  table: string;
  rowCount: number;
  idemKey: string;
  proposal: string;
  /** Multi-approver / quorum policy (ADR 0070). Omit for the single-decision gate. */
  policy?: ApprovalPolicy;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'warehouse-load',
    syncId: input.syncId,
    dataset: input.dataset,
    table: input.table,
    rowCount: input.rowCount,
    spendIdemKey: input.idemKey,
    proposal: input.proposal,
    ...(input.policy ? { policy: input.policy } : {}),
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * Create a CMS content-publish approval (ADR 0066). Same durable queue + CAS
 * resolve as run proposals/assistant actions — a CMS editor is one more proposer
 * on the single loop. No agent, no run: `rosterId`/`persona`/`workflowId` are
 * empty; the decide path is the CMS feature's content-approval handler, which
 * transitions the page. NOT a second approval store (ADR 0025 §4).
 */
export async function createContentApproval(input: {
  tenantId: string;
  orgId: string;
  pageId: string;
  pageTitle: string;
  proposal: string;
  /** The page's `version` at submit time — what the reviewer is agreeing to. */
  pageVersion?: number;
  /** ADR 0593 D4 — locales carrying durable `aiDrafted` stamps (machine drafts
   *  the reviewer must be told about). */
  aiDraftedLocales?: string[];
  /**
   * Multi-approver / quorum policy (ADR 0070). Omit for the single-decision gate.
   *
   * ADR 0672 D6 (`CMSAWF-9`) — **this parameter was going to be REMOVED and must not be.**
   * The plan was to make "no CMS lane mints a quorum row" a compile-time fact rather than a
   * grep-shaped assertion. Removing it does not compile: two tests legitimately pass a
   * policy here — `test/approval-quorum.test.ts` (the only real coverage of
   * `evaluateQuorum`) and `test/subject-erasure-host-stores-adr0464.test.ts`, which needs a
   * policy-BEARING row to verify approver-ref redaction on erasure, a concern unrelated to
   * CMS. Deleting the parameter would have removed real coverage from another feature to
   * tidy a claim about this one.
   *
   * The claim is therefore pinned where it is actually true — over PRODUCTION call sites —
   * in `test/approval-quorum-cms-lanes.test.ts`.
   */
  policy?: ApprovalPolicy;
  /** ADR 0859 D3 — who submitted (see `PendingApproval.submitters`). */
  submitters?: string[];
  /** ADR 0859 D4 — see `PendingApproval.submitterCauses`. */
  submitterCauses?: string[];
  /** ADR 0859 D5 — see `PendingApproval.liveReferenceSections`. */
  liveReferenceSections?: Array<{ sectionId: string; type: string }>;
  /** ADR 0861 D6 addendum — see `PendingApproval.outdatedTranslationLocales`. */
  outdatedTranslationLocales?: string[];
  /** ADR 0859 D2 — a DETERMINISTIC id for this review cycle. Given, the row is
   *  created with `compareAndSwap(null, …)` and a lost race returns the winner's
   *  row with `created: false` (use `createContentApprovalOnce` to see that). */
  approvalId?: string;
}): Promise<PendingApproval> {
  return (await createContentApprovalOnce(input)).approval;
}

/**
 * ADR 0859 D2 (`CMSA2WF-2`) — `createContentApproval` that reports whether THIS call
 * created the row. With a caller-supplied `approvalId` the create is a storage CAS, so
 * two submits racing on one page — on one instance or two — converge on ONE row; the
 * loser gets the winner's row back (`created: false`) and the caller repins it. It is
 * the anon-surface-write creator's shape (deterministic id + `compareAndSwap(null)`),
 * which this kind had been deferring since `CMSAWF-5`.
 *
 * The loser re-indexes the winner's row: indexing is idempotent, and a crash between
 * the winner's CAS and its index would otherwise leave a row no status read can find.
 */
export async function createContentApprovalOnce(
  input: Parameters<typeof createContentApproval>[0],
): Promise<{ approval: PendingApproval; created: boolean }> {
  const approval: PendingApproval = {
    approvalId: input.approvalId ?? `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'content-publish',
    orgId: input.orgId,
    pageId: input.pageId,
    pageTitle: input.pageTitle,
    ...(input.pageVersion !== undefined ? { pageVersion: input.pageVersion } : {}),
    ...(input.aiDraftedLocales && input.aiDraftedLocales.length > 0 ? { aiDraftedLocales: input.aiDraftedLocales } : {}),
    ...(input.submitters && input.submitters.length > 0 ? { submitters: [...new Set(input.submitters)] } : {}),
    ...(input.submitterCauses && input.submitterCauses.length > 0 ? { submitterCauses: [...new Set(input.submitterCauses)] } : {}),
    ...(input.liveReferenceSections && input.liveReferenceSections.length > 0 ? { liveReferenceSections: input.liveReferenceSections } : {}),
    ...(input.outdatedTranslationLocales && input.outdatedTranslationLocales.length > 0 ? { outdatedTranslationLocales: input.outdatedTranslationLocales } : {}),
    proposal: input.proposal,
    ...(input.policy ? { policy: input.policy } : {}),
    status: 'pending',
    createdAt: nowIso(),
  };
  if (input.approvalId === undefined) {
    await approvals.put(approval);
    await indexApproval(approval);
    return { approval, created: true };
  }
  if (await approvals.compareAndSwap(null, approval)) {
    await indexApproval(approval);
    return { approval, created: true };
  }
  const winner = await approvals.get(input.approvalId);
  if (!winner) throw new OpenwopError('conflict', 'Could not create the review (concurrent write).', 409, { approvalId: input.approvalId });
  // Only a still-PENDING winner is re-indexed: one decided in the window already moved
  // its own index entry, and re-writing `pending` here would strand a stale one
  // (code grade CMSA2CD-8).
  if (winner.status === 'pending') await indexApproval(winner);
  return { approval: winner, created: false };
}

/**
 * The content-publish decision handler, registered by the CMS FEATURE at boot
 * (core owns the hook; the feature depends on core, never the reverse — the
 * same discipline as the assistant-action handler). The approvals routes call
 * this for `kind: 'content-publish'` approvals so the inbox claim/reject path
 * and the CMS publish flow share ONE implementation. The handler enforces org
 * RBAC (`host:members:manage`) + IDOR and transitions the page.
 */
export type ContentApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  /** `isSuperadmin`: computed at the HTTP boundary (`decidedBySuperadmin`). The
   *  handler honours it ONLY for the reserved system-site org (MyndHyve B2). */
  opts: { decidedByUserId?: string; note?: string; isSuperadmin?: boolean },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let contentApprovalHandler: ContentApprovalHandler | null = null;

export function registerContentApprovalHandler(fn: ContentApprovalHandler): void {
  contentApprovalHandler = fn;
}

export function getContentApprovalHandler(): ContentApprovalHandler | null {
  return contentApprovalHandler;
}

/**
 * ADR 0905 D3 — create an `email-campaign-send` approval on a DETERMINISTIC id with
 * `compareAndSwap(null, …)` (the `createContentApprovalOnce` shape): two submits racing
 * on one campaign converge on one row, and the loser gets the winner's row back
 * (`created: false`) to repin. Same queue, inbox and CAS resolve (ADR 0025 §4).
 */
export async function createEmailSendApprovalOnce(input: {
  tenantId: string;
  orgId: string;
  approvalId: string;
  emailSend: NonNullable<PendingApproval['emailSend']>;
  proposal: string;
  submitters: string[];
  submitterCauses?: string[];
  approverGroupRefs?: string[];
  approverRoleRefs?: string[];
}): Promise<{ approval: PendingApproval; created: boolean }> {
  const refs = emailSendPolicy(input);
  const approval: PendingApproval = {
    approvalId: input.approvalId,
    tenantId: input.tenantId,
    rosterId: '', persona: '', workflowId: '',
    kind: 'email-campaign-send',
    orgId: input.orgId,
    emailSend: input.emailSend,
    emailSendRevision: randomUUID(),
    ...(input.submitters.length > 0 ? { submitters: [...new Set(input.submitters)] } : {}),
    ...(input.submitterCauses?.length ? { submitterCauses: [...new Set(input.submitterCauses)] } : {}),
    proposal: input.proposal,
    ...(refs ? { policy: refs } : {}),
    status: 'pending',
    createdAt: nowIso(),
  };
  if (await approvals.compareAndSwap(null, approval)) {
    await indexApproval(approval);
    return { approval, created: true };
  }
  const winner = await approvals.get(input.approvalId);
  if (!winner) throw new OpenwopError('conflict', 'Could not create the review (concurrent write).', 409, { approvalId: input.approvalId });
  if (winner.status === 'pending') await indexApproval(winner);
  return { approval: winner, created: false };
}

/** ADR 0905 D3 — approver refs ride `policy` at `requiredApprovals: 1` (inert quorum). */
function emailSendPolicy(input: { approverGroupRefs?: string[]; approverRoleRefs?: string[] }): ApprovalPolicy | undefined {
  const groups = (input.approverGroupRefs ?? []).filter(Boolean);
  const roles = (input.approverRoleRefs ?? []).filter(Boolean);
  if (groups.length === 0 && roles.length === 0) return undefined;
  return { requiredApprovals: 1, ...(groups.length ? { approverGroupRefs: groups } : {}), ...(roles.length ? { approverRoleRefs: roles } : {}) };
}

/** ADR 0905 D3 — re-point an OPEN `email-campaign-send` row at the campaign's current
 *  pin (a resubmit). Submitters are UNIONED, never replaced (ADR 0859 D3); the
 *  approver refs are re-stamped from the org's current setting. */
export async function repinEmailSendApproval(
  approvalId: string,
  patch: { emailSend: NonNullable<PendingApproval['emailSend']>; proposal: string; submitters: string[]; submitterCauses?: string[]; approverGroupRefs?: string[]; approverRoleRefs?: string[] },
): Promise<PendingApproval | null> {
  return withApprovalLock(approvalId, async () => {
    const cur = await approvals.get(approvalId);
    if (!cur || cur.kind !== 'email-campaign-send' || cur.status !== 'pending') return null;
    const submitters = [...new Set([...(cur.submitters ?? []), ...patch.submitters])];
    const submitterCauses = [...new Set([...(cur.submitterCauses ?? []), ...(patch.submitterCauses ?? [])])];
    const refs = emailSendPolicy(patch);
    const { policy: _old, ...rest } = cur;
    const next: PendingApproval = { ...rest, emailSend: patch.emailSend, emailSendRevision: randomUUID(), proposal: patch.proposal, ...(submitters.length ? { submitters } : {}), ...(submitterCauses.length ? { submitterCauses } : {}), ...(refs ? { policy: refs } : {}) };
    if (!(await approvals.compareAndSwap(cur, next))) return null;
    return next;
  });
}

/** ADR 0905 D3 — the `email-campaign-send` decide handler, registered by the email
 *  FEATURE at boot (core owns the hook; feature → core only). */
export type EmailSendApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string; expectedContentHash?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;
let emailSendApprovalHandler: EmailSendApprovalHandler | null = null;
export function registerEmailSendApprovalHandler(fn: EmailSendApprovalHandler): void { emailSendApprovalHandler = fn; }
export function getEmailSendApprovalHandler(): EmailSendApprovalHandler | null { return emailSendApprovalHandler; }

/**
 * ADR 0948 P1b — create a `funnel-publish` approval on a DETERMINISTIC id with
 * `compareAndSwap(null, …)` (the `createEmailSendApprovalOnce` shape): two requests for
 * the same funnel content converge on one row, the loser gets the winner back
 * (`created: false`) — whatever its status, so the CALLER checks it is still pending.
 *
 * `policy` + `autonomySourceRunId` (ADR 0948 P1b × ADR 0942): set ONLY when the
 * autonomy chokepoint resolved `content.publish` to approve for a campaign-bound run.
 * The shared eligibility check (`registerAutonomyPolicyRowEligibility`) then admits
 * only the policy's named, non-requesting approvers, on top of the funnels decide
 * handler's own `workspace:write` floor; the core quorum counts their votes.
 */
export async function createFunnelPublishApprovalOnce(input: {
  tenantId: string;
  orgId: string;
  approvalId: string;
  funnelPublish: NonNullable<PendingApproval['funnelPublish']>;
  proposal: string;
  submitters: string[];
  /** ADR 0859 D4 — a member who CAUSED an actorless run: narrows separation of duties only. */
  submitterCauses?: string[];
  policy?: ApprovalPolicy;
  autonomySourceRunId?: string;
}): Promise<{ approval: PendingApproval; created: boolean }> {
  const approval: PendingApproval = {
    approvalId: input.approvalId,
    tenantId: input.tenantId,
    rosterId: '', persona: '', workflowId: '',
    kind: 'funnel-publish',
    orgId: input.orgId,
    funnelPublish: input.funnelPublish,
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.autonomySourceRunId ? { autonomySourceRunId: input.autonomySourceRunId } : {}),
    ...(input.submitters.length > 0 ? { submitters: [...new Set(input.submitters)] } : {}),
    ...(input.submitterCauses && input.submitterCauses.length > 0 ? { submitterCauses: [...new Set(input.submitterCauses)] } : {}),
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  if (await approvals.compareAndSwap(null, approval)) {
    await indexApproval(approval);
    return { approval, created: true };
  }
  const winner = await approvals.get(input.approvalId);
  if (!winner || winner.kind !== 'funnel-publish' || winner.tenantId !== input.tenantId || winner.orgId !== input.orgId
    || winner.funnelPublish?.funnelId !== input.funnelPublish.funnelId || winner.funnelPublish.digest !== input.funnelPublish.digest
    || (winner.funnelPublish.gate ?? '') !== (input.funnelPublish.gate ?? '')) {
    throw new OpenwopError('conflict', 'Could not confirm the publish review.', 409, { reason: 'review_unconfirmed' });
  }
  if (winner.status === 'pending') await indexApproval(winner);
  return { approval: winner, created: false };
}

/** ADR 0948 P1b — the `funnel-publish` decide handler, registered by the funnels
 *  FEATURE at boot (core owns the hook; feature → core only). */
export type FunnelPublishApprovalHandler = EmailSendApprovalHandler;
let funnelPublishApprovalHandler: FunnelPublishApprovalHandler | null = null;
export function registerFunnelPublishApprovalHandler(fn: FunnelPublishApprovalHandler): void { funnelPublishApprovalHandler = fn; }
export function getFunnelPublishApprovalHandler(): FunnelPublishApprovalHandler | null { return funnelPublishApprovalHandler; }

/**
 * ADR 0458 §2.2 (correction, 2026-09-15) — the challenge-publish decision handler,
 * registered by the `kicktodo-creator` FEATURE at boot (core owns the hook; the
 * feature depends on core, never the reverse — the content-publish discipline).
 * Until this existed, `kind: 'challenge-publish'` fell through the run-proposal
 * finalizer, which resolves the proposing roster entry first — and the factory's
 * approval names `host:kicktodo-factory`, which is a persona, not a roster row. So
 * every APPROVE from the reviews inbox 404'd ("Proposing agent no longer exists")
 * while REJECT worked, and the only way to publish was the creator's own
 * `complete-publication` route, which no client called after ADR 0458 P4 pointed
 * approvers at the inbox. The handler routes approve to `completePublication`
 * (separation of duties + gates re-run there, unchanged) and reject to a plain
 * resolve, so the inbox card, decide-by-email and the approvals routes share ONE
 * publication act.
 */
export type ChallengePublishApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let challengePublishApprovalHandler: ChallengePublishApprovalHandler | null = null;

export function registerChallengePublishApprovalHandler(fn: ChallengePublishApprovalHandler): void {
  challengePublishApprovalHandler = fn;
}

export function getChallengePublishApprovalHandler(): ChallengePublishApprovalHandler | null {
  return challengePublishApprovalHandler;
}

/**
 * KickTodo sign-off kinds — `community-profile`, `community-review`,
 * `metrics-verifier-sample`, `connect-seller`. Each is a governance sign-off whose
 * decision IS the act (or, for the last two, the record a feature reads back), not
 * a run. All four used to fall through the run-proposal finalizer, which resolves
 * the proposing roster entry first — and their approvals name host personas
 * (`host:kicktodo-community`, `host:kicktodo-commerce`) that are not roster rows.
 * So every APPROVE from the reviews inbox 404'd ("Proposing agent no longer
 * exists") while REJECT resolved the row without touching the profile or review it
 * was about: the moderation loop never closed. Same trap as challenge-publish and
 * commerce-spend; same cure. The owning kicktodo-* feature registers the handler at
 * boot (core owns the hook; the feature depends on core, never the reverse).
 */
export type KicktodoSignoffKind = 'community-profile' | 'community-review' | 'metrics-verifier-sample' | 'connect-seller';
export type KicktodoSignoffApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

const kicktodoSignoffHandlers = new Map<KicktodoSignoffKind, KicktodoSignoffApprovalHandler>();

export function registerKicktodoSignoffApprovalHandler(kind: KicktodoSignoffKind, fn: KicktodoSignoffApprovalHandler): void {
  kicktodoSignoffHandlers.set(kind, fn);
}

export function getKicktodoSignoffApprovalHandler(kind: KicktodoSignoffKind): KicktodoSignoffApprovalHandler | null {
  return kicktodoSignoffHandlers.get(kind) ?? null;
}

/**
 * ADR 0469 A4 — the anon-surface-write decision handler, registered by the
 * `anonymousActor` host module at boot. Unlike every other feature handler (a
 * status flip), this one EXECUTES the held tool call on APPROVE (deferred
 * execution: the visitor never returns) — tenant-scoped with `actingUserId`
 * undefined (the ADR 0468 no-secret floor) + `guardAnonEgress`, then records the
 * terminal outcome. Reject ⇒ no effect. Lives in `anonymousActor` because the
 * execution needs the scoped tool provider + egress guard core doesn't import.
 */
export type AnonSurfaceWriteApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let anonSurfaceWriteApprovalHandler: AnonSurfaceWriteApprovalHandler | null = null;

export function registerAnonSurfaceWriteApprovalHandler(fn: AnonSurfaceWriteApprovalHandler): void {
  anonSurfaceWriteApprovalHandler = fn;
}

export function getAnonSurfaceWriteApprovalHandler(): AnonSurfaceWriteApprovalHandler | null {
  return anonSurfaceWriteApprovalHandler;
}

/**
 * ADR 0469 A2 — create (IDEMPOTENTLY) the durable approval that HOLDS an anon
 * visitor's granted write. Deterministic id `appr:anon:<runId>:<toolCallIdx>` +
 * `compareAndSwap(null, …)`: a retried dispatch reuses the SAME row instead of
 * flooding the operator inbox with duplicates — deliberately NOT the random-id
 * `createContentApproval` pattern (the architecture-review idempotency finding).
 * The CALLER MUST gate the anon write cap BEFORE calling this (anti-flood).
 */
export async function createAnonSurfaceWriteApproval(input: {
  tenantId: string;
  orgId: string;
  widgetId: string;
  principal: string;
  runId: string;
  toolCallIdx: number;
  tool: { name: string; args?: Record<string, unknown>; destination?: string };
  captured?: { name?: string; email?: string; note?: string };
}): Promise<PendingApproval> {
  const approvalId = `appr:anon:${input.runId}:${input.toolCallIdx}`;
  const existing = await approvals.get(approvalId);
  if (existing) return existing; // idempotent — a retried dispatch reuses the row
  const approval: PendingApproval = {
    approvalId,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    proposal: `Anonymous visitor requested: ${input.tool.name}`,
    kind: 'anon-surface-write',
    orgId: input.orgId,
    anonSurfaceWrite: {
      widgetId: input.widgetId,
      principal: input.principal,
      runId: input.runId,
      toolCallIdx: input.toolCallIdx,
      tool: input.tool,
      ...(input.captured?.name ? { capturedName: input.captured.name } : {}),
      ...(input.captured?.email ? { capturedEmail: input.captured.email } : {}),
      ...(input.captured?.note ? { capturedNote: input.captured.note } : {}),
    },
    status: 'pending',
    createdAt: nowIso(),
  };
  const created = await approvals.compareAndSwap(null, approval);
  if (!created) return (await approvals.get(approvalId)) ?? approval; // lost create race → the winner's row
  await indexApproval(approval);
  return approval;
}

/**
 * ADR 0473 — the composed-workflow decision handler, registered by the
 * workflow-composition module (host/workflowComposeTool.ts) at boot. Like the
 * anon-surface-write handler it EXECUTES on APPROVE — CAS first, then the
 * post-CAS definition-hash re-verify, then the proposed run via the ONE
 * `startWorkflowRun` recipe — and on REJECT archives the transient draft.
 * Lives outside core because execution needs `StartRunDeps`, which this module
 * doesn't import.
 */
export type ComposedWorkflowApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string; expectedDefinitionHash?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let composedWorkflowApprovalHandler: ComposedWorkflowApprovalHandler | null = null;

export function registerComposedWorkflowApprovalHandler(fn: ComposedWorkflowApprovalHandler): void {
  composedWorkflowApprovalHandler = fn;
}

export function getComposedWorkflowApprovalHandler(): ComposedWorkflowApprovalHandler | null {
  return composedWorkflowApprovalHandler;
}

/**
 * ADR 0473 — create the hold for an agent-composed workflow proposal. The draft
 * MUST already be registered transient + tenant-owned; the CALLER gates the
 * transient cap BEFORE calling (the anon creator's anti-flood contract).
 * Deliberately NOT idempotent — each proposal is a distinct review object; the
 * cap bounds retry abuse.
 */
export async function createComposedWorkflowApproval(input: {
  tenantId: string;
  workflowId: string;
  /** One-line intent for the reviewer card (agent-authored). */
  proposal: string;
  /** ADR 0478 §3 — the agent's stated WHY (optional, sanitized upstream). */
  reasoning?: string;
  /** In-thread placement (ADR 0311) — the proposing conversation. */
  conversationId?: string;
  composedWorkflow: NonNullable<PendingApproval['composedWorkflow']>;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: input.workflowId,
    kind: 'composed-workflow',
    proposal: input.proposal,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    composedWorkflow: input.composedWorkflow,
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/**
 * ADR 0385 (chat-first-port F3) — create a commerce-listing-publish approval: the
 * operator sign-off gate for a seller's native-paid/external-link listing. Same
 * durable queue + CAS resolve as every other proposer — NOT a second approval
 * store. No agent, no run; the decide path is the commerce-connect feature's
 * registered handler, which enforces superadmin and flips the listing mirror.
 * Stored under the SELLER's tenant.
 */
export async function createCommerceListingApproval(input: {
  sellerTenantId: string;
  packName: string;
  lane: string;
  version: string;
  proposal: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.sellerTenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'commerce-listing-publish',
    commerceListing: { packName: input.packName, sellerTenantId: input.sellerTenantId, lane: input.lane, version: input.version },
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/** The seller-tenant-scoped pending listing approval for a pack, or null. Used to
 *  dedupe (identical material reuses the row) + supersede (a material edit rejects
 *  the stale row and queues a fresh one). */
export async function findPendingCommerceListingApproval(sellerTenantId: string, packName: string): Promise<PendingApproval | null> {
  return (await listApprovals(sellerTenantId, 'pending'))
    .find((a) => a.kind === 'commerce-listing-publish' && a.commerceListing?.packName === packName) ?? null;
}

/** Host-global pending listing approvals (the operator queue read). A superadmin
 *  admin surface, bounded by the count of pending listings — the same posture as
 *  the listings-store scan it replaces (never a per-tenant hot path). */
export async function listPendingCommerceListingApprovals(): Promise<PendingApproval[]> {
  return (await approvals.list())
    .filter((a) => a.kind === 'commerce-listing-publish' && a.status === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The commerce-listing-publish decision handler, registered by the COMMERCE-CONNECT
 * feature at boot (core owns the hook; the feature depends on core — the
 * content-publish discipline). The decision core dispatches here for
 * `kind: 'commerce-listing-publish'` in BOTH the claim and reject paths. The
 * handler enforces SUPERADMIN (`opts.isSuperadmin`, computed at the HTTP boundary
 * where the caller principal is known) and flips the listing's `approvalState`.
 */
export type CommerceListingApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string; isSuperadmin?: boolean },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let commerceListingApprovalHandler: CommerceListingApprovalHandler | null = null;
export function registerCommerceListingApprovalHandler(fn: CommerceListingApprovalHandler): void {
  commerceListingApprovalHandler = fn;
}
export function getCommerceListingApprovalHandler(): CommerceListingApprovalHandler | null {
  return commerceListingApprovalHandler;
}

/**
 * Create a strategy-activation approval (ADR 0230 §B3). Same durable queue +
 * CAS resolve as run proposals / content publishes — an executive activating a
 * strategy is one more proposer on the single loop. No agent, no run; the
 * decide path is the strategy feature's activation handler. NOT a second
 * approval store (ADR 0025 §4).
 */
export async function createStrategyActivationApproval(input: {
  tenantId: string;
  orgId: string;
  strategyId: string;
  strategyTitle: string;
  /** ADR 0597 §3 — the status the strategy held when the gate intercepted. */
  strategyFromStatus?: string;
  /** ADR 0845 D2/D5 — the binding shown on the card, its digest, and the submitter. */
  strategySnapshot?: Record<string, unknown>;
  strategyContentDigest?: string;
  strategyRequestedBy?: string;
  proposal: string;
  /** Multi-approver / quorum policy (ADR 0070). Omit for the single-decision gate. */
  policy?: ApprovalPolicy;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'strategy-activation',
    orgId: input.orgId,
    strategyId: input.strategyId,
    strategyTitle: input.strategyTitle,
    ...(input.strategyFromStatus ? { strategyFromStatus: input.strategyFromStatus } : {}),
    ...(input.strategySnapshot ? { strategySnapshot: input.strategySnapshot } : {}),
    ...(input.strategyContentDigest ? { strategyContentDigest: input.strategyContentDigest } : {}),
    ...(input.strategyRequestedBy ? { strategyRequestedBy: input.strategyRequestedBy } : {}),
    proposal: input.proposal,
    ...(input.policy ? { policy: input.policy } : {}),
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

export async function hasPendingApprovalForStrategy(tenantId: string, strategyId: string): Promise<boolean> {
  return (await listApprovals(tenantId, 'pending')).some((a) => a.kind === 'strategy-activation' && a.strategyId === strategyId);
}

/**
 * The strategy-activation decision handler, registered by the STRATEGY feature
 * at boot (core owns the hook; the feature depends on core, never the reverse —
 * the content-publish discipline, ADR 0230 §B3). The decision core dispatches
 * here for `kind: 'strategy-activation'` approvals in BOTH the claim and reject
 * paths. The handler enforces org RBAC (`host:members:manage`) + IDOR and
 * transitions the strategy.
 */
export type StrategyActivationApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let strategyActivationApprovalHandler: StrategyActivationApprovalHandler | null = null;

export function registerStrategyActivationApprovalHandler(fn: StrategyActivationApprovalHandler): void {
  strategyActivationApprovalHandler = fn;
}

export function getStrategyActivationApprovalHandler(): StrategyActivationApprovalHandler | null {
  return strategyActivationApprovalHandler;
}

// ── ADR 0924: campaign-ops change-set approval ─────────────────────────────────

/** The decide handler the campaign-ops feature registers (core owns the hook). It
 *  enforces every ADR 0924 D2 check — the hash the decider saw, the request and
 *  asset versions, the client, separation of duties — before resolving. */
export type CampaignChangeSetApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string; expectedChangeSetHash?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let campaignChangeSetApprovalHandler: CampaignChangeSetApprovalHandler | null = null;
export function registerCampaignChangeSetApprovalHandler(fn: CampaignChangeSetApprovalHandler): void {
  campaignChangeSetApprovalHandler = fn;
}
export function getCampaignChangeSetApprovalHandler(): CampaignChangeSetApprovalHandler | null {
  return campaignChangeSetApprovalHandler;
}

/** ADR 0924 D1 — one row per change set (deterministic id, `compareAndSwap(null)`),
 *  so a resubmit cannot open a second review and a new change set always opens a
 *  new one. Returns the winner's row with `created: false` on a lost race. */
export async function createChangeSetApprovalOnce(input: {
  tenantId: string;
  orgId: string;
  approvalId: string;
  changeSetId: string;
  changeSetHash: string;
  requestId: string;
  requestVersion: number;
  sourceVersions: Record<string, { version: number; contentHash: string }>;
  proposedBy: string;
  proposal: string;
  policy?: ApprovalPolicy;
}): Promise<{ approval: PendingApproval; created: boolean }> {
  const approval: PendingApproval = {
    approvalId: input.approvalId,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'campaign-change-set',
    orgId: input.orgId,
    changeSetId: input.changeSetId,
    changeSetHash: input.changeSetHash,
    changeSetRequestId: input.requestId,
    changeSetRequestVersion: input.requestVersion,
    changeSetSourceVersions: input.sourceVersions,
    changeSetProposedBy: input.proposedBy,
    proposal: input.proposal,
    ...(input.policy ? { policy: input.policy } : {}),
    status: 'pending',
    createdAt: nowIso(),
  };
  if (await approvals.compareAndSwap(null, approval)) {
    await indexApproval(approval);
    return { approval, created: true };
  }
  const winner = await approvals.get(input.approvalId);
  if (!winner) throw new OpenwopError('conflict', 'Could not create the review (concurrent write).', 409, { approvalId: input.approvalId });
  if (winner.status === 'pending') await indexApproval(winner);
  return { approval: winner, created: false };
}

// ── ADR 0959 D7: campaign-playbooks rollout approval ───────────────────────────

/** The decide handler the campaign-playbooks feature registers (core owns the hook). It
 *  re-plans the rollout and refuses when the plan no longer hashes to what the approver
 *  saw, enforces separation of duties, and moves the rollout. */
export type PlaybookRolloutApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let playbookRolloutApprovalHandler: PlaybookRolloutApprovalHandler | null = null;
export function registerPlaybookRolloutApprovalHandler(fn: PlaybookRolloutApprovalHandler): void {
  playbookRolloutApprovalHandler = fn;
}
export function getPlaybookRolloutApprovalHandler(): PlaybookRolloutApprovalHandler | null {
  return playbookRolloutApprovalHandler;
}

/** ADR 0959 D7 — one row per rollout (deterministic id, `compareAndSwap(null)`). */
export async function createPlaybookRolloutApprovalOnce(input: {
  tenantId: string;
  approvalId: string;
  rolloutId: string;
  playbookId: string;
  planHash: string;
  requestedBy: string;
  proposal: string;
}): Promise<{ approval: PendingApproval; created: boolean }> {
  const approval: PendingApproval = {
    approvalId: input.approvalId,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'playbook-rollout',
    orgId: input.tenantId,
    playbookRolloutId: input.rolloutId,
    playbookId: input.playbookId,
    playbookRolloutPlanHash: input.planHash,
    playbookRolloutRequestedBy: input.requestedBy,
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  if (await approvals.compareAndSwap(null, approval)) {
    await indexApproval(approval);
    return { approval, created: true };
  }
  const winner = await approvals.get(input.approvalId);
  if (!winner) throw new OpenwopError('conflict', 'Could not create the review (concurrent write).', 409, { approvalId: input.approvalId });
  if (winner.status === 'pending') await indexApproval(winner);
  return { approval: winner, created: false };
}

// ── CHAT-FIRST-PORT-AUDIT D3: strategy check-in + PM scenario-select gates ────
// Two agent-proposed decisions that previously resolved on bespoke page controls
// (check-in confirm/dismiss; scenario "select as plan of record") — reconciled
// onto the ONE shared approvals queue so they render in the reviews inbox and the
// originating conversation, and deciding from the inbox and from the page are the
// SAME CAS operation (no double-decide, no bespoke minting). Same durable queue +
// CAS resolve as every other gate; no agent, no run; the decide path is the
// owning feature's registered handler, which applies the effect.

/**
 * Create a strategy check-in approval (ADR 0231 measurement proposal). Called
 * from `appendCheckIn` when an agent-origin write lands a PROPOSED row — one
 * approval per `checkInId` (the deterministic key; a resubmission reuses via
 * `findApprovalForCheckIn`). Approve CONFIRMS the check-in, reject DISMISSES it.
 */
export async function createStrategyCheckInApproval(input: {
  tenantId: string;
  orgId: string;
  strategyId: string;
  strategyTitle?: string;
  checkInId: string;
  krId: string;
  krTitle?: string;
  proposal: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'strategy-checkin',
    orgId: input.orgId,
    strategyId: input.strategyId,
    ...(input.strategyTitle ? { strategyTitle: input.strategyTitle } : {}),
    strategyCheckIn: { checkInId: input.checkInId, krId: input.krId, ...(input.krTitle ? { krTitle: input.krTitle } : {}) },
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/** The approval (any status) bound to a proposed check-in, or null. The
 *  deterministic key is `checkInId`: creation dedups on a pending one; the page
 *  decide route resolves the found row through the shared CAS path (so a resolved
 *  row refuses a second decide, typed 409). */
export async function findApprovalForCheckIn(tenantId: string, checkInId: string): Promise<PendingApproval | null> {
  return (await listApprovals(tenantId)).find(
    (a) => a.kind === 'strategy-checkin' && a.strategyCheckIn?.checkInId === checkInId,
  ) ?? null;
}

export async function hasPendingApprovalForCheckIn(tenantId: string, checkInId: string): Promise<boolean> {
  return (await listApprovals(tenantId, 'pending')).some(
    (a) => a.kind === 'strategy-checkin' && a.strategyCheckIn?.checkInId === checkInId,
  );
}

export type StrategyCheckInApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let strategyCheckInApprovalHandler: StrategyCheckInApprovalHandler | null = null;
export function registerStrategyCheckInApprovalHandler(fn: StrategyCheckInApprovalHandler): void {
  strategyCheckInApprovalHandler = fn;
}
export function getStrategyCheckInApprovalHandler(): StrategyCheckInApprovalHandler | null {
  return strategyCheckInApprovalHandler;
}

/**
 * Create a PM scenario-select approval (ADR 0235 §D1). Called from `addScenario`
 * when the scenario is `proposedBy:'agent'` — one approval per `scenarioId` (the
 * deterministic key; a resubmission reuses via `findApprovalForScenario`).
 * Approve SELECTS the scenario as plan of record; reject leaves it un-adopted.
 */
export async function createScenarioSelectApproval(input: {
  tenantId: string;
  orgId: string;
  listId: string;
  sessionId: string;
  scenarioId: string;
  scenarioName?: string;
  proposal: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'pm-scenario-select',
    orgId: input.orgId,
    scenarioSelect: { listId: input.listId, sessionId: input.sessionId, scenarioId: input.scenarioId, ...(input.scenarioName ? { scenarioName: input.scenarioName } : {}) },
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

export async function findApprovalForScenario(tenantId: string, scenarioId: string): Promise<PendingApproval | null> {
  return (await listApprovals(tenantId)).find(
    (a) => a.kind === 'pm-scenario-select' && a.scenarioSelect?.scenarioId === scenarioId,
  ) ?? null;
}

export async function hasPendingApprovalForScenario(tenantId: string, scenarioId: string): Promise<boolean> {
  return (await listApprovals(tenantId, 'pending')).some(
    (a) => a.kind === 'pm-scenario-select' && a.scenarioSelect?.scenarioId === scenarioId,
  );
}

export type ScenarioSelectApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let scenarioSelectApprovalHandler: ScenarioSelectApprovalHandler | null = null;
export function registerScenarioSelectApprovalHandler(fn: ScenarioSelectApprovalHandler): void {
  scenarioSelectApprovalHandler = fn;
}
export function getScenarioSelectApprovalHandler(): ScenarioSelectApprovalHandler | null {
  return scenarioSelectApprovalHandler;
}

/**
 * ADR 0387 / H2 — create an environment-promotion approval (the config
 * promote/rollback gate). Same durable queue + CAS resolve as every other
 * proposer — NOT a second approval store. No agent, no run; the decide path is
 * the environments feature's registered handler, which performs the pointer
 * move on approve and parks a rejected ledger row on reject.
 */
export async function createEnvironmentPromotionApproval(input: {
  tenantId: string;
  toEnv: string;
  fromEnv: string | null;
  snapshotHash: string;
  proposal: string;
  /** ADR 0732 D1 — the proposer. Both call sites already hold it as `actor`. */
  requestedBy?: string;
}): Promise<PendingApproval> {
  // Phase-3 review LOW-1 — DETERMINISTIC id per (tenant, toEnv, snapshotHash):
  // two concurrent identical promotes converge on one row (put is last-write-wins
  // on the same key; both callers then find the same pending approval) instead of
  // minting two review rows.
  const idHash = createHash('sha256').update(`${input.tenantId}\u0000${input.toEnv}\u0000${input.snapshotHash}`).digest('hex').slice(0, 24);
  // A RESOLVED historical row for the same triple keeps its audit record — a
  // re-submission after a decide gets a fresh suffixed id instead of clobbering.
  const prior = await approvals.get(`appr:envp-${idHash}`);
  const approvalId = prior && prior.status !== 'pending' ? `appr:envp-${idHash}-${randomUUID().slice(0, 8)}` : `appr:envp-${idHash}`;
  const approval: PendingApproval = {
    approvalId,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'environment-promotion',
    envPromotion: {
      toEnv: input.toEnv,
      fromEnv: input.fromEnv,
      snapshotHash: input.snapshotHash,
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    },
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/** ADR 0387 / H2 — the pending environment-promotion for a (toEnv, snapshotHash),
 *  or null. The deterministic idempotency key: re-submitting an identical
 *  promote reuses this instead of queueing a duplicate review. */
export async function findPendingEnvironmentPromotion(
  tenantId: string,
  toEnv: string,
  snapshotHash: string,
): Promise<PendingApproval | null> {
  return (
    (await listApprovals(tenantId, 'pending')).find(
      (a) => a.kind === 'environment-promotion' && a.envPromotion?.toEnv === toEnv && a.envPromotion?.snapshotHash === snapshotHash,
    ) ?? null
  );
}

/**
 * The environment-promotion decision handler, registered by the ENVIRONMENTS
 * feature at boot (core owns the hook; the feature depends on core — the
 * content-publish / strategy-activation discipline). The decision core
 * dispatches here for `kind: 'environment-promotion'` in BOTH the claim and
 * reject paths. The handler enforces tenant RBAC (`host:members:manage`) and
 * moves the pointer (approve) or parks a rejected row (reject).
 */
export type EnvironmentPromotionApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let environmentPromotionApprovalHandler: EnvironmentPromotionApprovalHandler | null = null;

export function registerEnvironmentPromotionApprovalHandler(fn: EnvironmentPromotionApprovalHandler): void {
  environmentPromotionApprovalHandler = fn;
}

export function getEnvironmentPromotionApprovalHandler(): EnvironmentPromotionApprovalHandler | null {
  return environmentPromotionApprovalHandler;
}

/** ADR 0264 / CDP-B — create a steward contact-merge approval (no agent, no run). */
export async function createContactMergeApproval(input: {
  tenantId: string; survivorContactId: string; sourceContactId: string; proposal: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '',
    persona: '',
    workflowId: '',
    kind: 'contact-merge',
    survivorContactId: input.survivorContactId,
    sourceContactId: input.sourceContactId,
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/** The contact-merge decision handler, registered by the CRM feature at boot (core
 *  owns the hook; the feature depends on core — the content-publish discipline). */
export type ContactMergeApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

let contactMergeApprovalHandler: ContactMergeApprovalHandler | null = null;
export function registerContactMergeApprovalHandler(fn: ContactMergeApprovalHandler): void {
  contactMergeApprovalHandler = fn;
}
export function getContactMergeApprovalHandler(): ContactMergeApprovalHandler | null {
  return contactMergeApprovalHandler;
}

// ── CFP-1 (D9) field-sales approval kinds — the SAME queue + inbox + CAS resolve
//    as every other proposer; no agent, no run. Each feature registers its decide
//    handler at boot (core owns the hook; the feature depends on core — the
//    content-publish / strategy-activation discipline). ──────────────────────────

/** Create a dealer-registration approval (CFP-1 / D9, ADR 0281). No agent, no run;
 *  the decide path is the dealers feature's registered handler. */
export async function createDealerRegistrationApproval(input: {
  tenantId: string; orgId: string; regId: string; dealerId: string; proposal: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    // REVIEW B5 — DETERMINISTIC in the registration id. The dedup used to be a read
    // (`findPendingDealerRegistrationApproval`) followed by a create, with no CAS, on a
    // path the admin list route now runs on EVERY GET: two concurrent reads both saw
    // "no pending card" and both created one. Two cards for one registration is worse
    // than none — a manager decides card A, card B stays pending, and rejecting B hits
    // `decideRegistration`'s 409 → `reopenApproval` → the unclearable item this pass
    // exists to remove. A `put` on the same key is idempotent, so the race cannot mint
    // a second card no matter how many callers arrive at once.
    approvalId: `appr:dealreg:${input.regId}`,
    tenantId: input.tenantId,
    rosterId: '', persona: '', workflowId: '',
    kind: 'dealer-registration',
    orgId: input.orgId,
    dealerRegistration: { regId: input.regId, dealerId: input.dealerId },
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  // A RESOLVED card for this registration must not be silently reopened by a re-submit
  // (that would resurrect a decided deal), so only create when nothing is there.
  const existing = await approvals.get(approval.approvalId);
  if (existing) return existing;
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/** The pending dealer-registration approval for a registration, or null — the
 *  deterministic per-entity dedup so a re-submit reuses the open review. */
export async function findPendingDealerRegistrationApproval(tenantId: string, regId: string): Promise<PendingApproval | null> {
  return (await listApprovals(tenantId, 'pending')).find((a) => a.kind === 'dealer-registration' && a.dealerRegistration?.regId === regId) ?? null;
}

export type DealerRegistrationApprovalHandler = (
  tenantId: string, approvalId: string, outcome: 'approved' | 'rejected', opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;
let dealerRegistrationApprovalHandler: DealerRegistrationApprovalHandler | null = null;
export function registerDealerRegistrationApprovalHandler(fn: DealerRegistrationApprovalHandler): void { dealerRegistrationApprovalHandler = fn; }
export function getDealerRegistrationApprovalHandler(): DealerRegistrationApprovalHandler | null { return dealerRegistrationApprovalHandler; }

/** Create a territory-model-transition approval (CFP-1 / D9, ADR 0272). */
export async function createTerritoryTransitionApproval(input: {
  tenantId: string; orgId: string; modelId: string; transition: 'activate' | 'archive'; proposal: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '', persona: '', workflowId: '',
    kind: 'territory-model-transition',
    orgId: input.orgId,
    territoryTransition: { modelId: input.modelId, transition: input.transition },
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/** The pending transition approval for a model, or null (per-entity dedup — a
 *  model can have at most one open transition review at a time). */
export async function findPendingTerritoryTransitionApproval(tenantId: string, modelId: string): Promise<PendingApproval | null> {
  return (await listApprovals(tenantId, 'pending')).find((a) => a.kind === 'territory-model-transition' && a.territoryTransition?.modelId === modelId) ?? null;
}

export type TerritoryTransitionApprovalHandler = (
  tenantId: string, approvalId: string, outcome: 'approved' | 'rejected', opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;
let territoryTransitionApprovalHandler: TerritoryTransitionApprovalHandler | null = null;
export function registerTerritoryTransitionApprovalHandler(fn: TerritoryTransitionApprovalHandler): void { territoryTransitionApprovalHandler = fn; }
export function getTerritoryTransitionApprovalHandler(): TerritoryTransitionApprovalHandler | null { return territoryTransitionApprovalHandler; }

/** Create a commission-statement approval (CFP-1 / D9, ADR 0280). */
export async function createCommissionStatementApproval(input: {
  tenantId: string; orgId: string; statementId: string; subjectId: string; period: string; total: number; currency: string; proposal: string;
}): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approvalId: `appr:${randomUUID()}`,
    tenantId: input.tenantId,
    rosterId: '', persona: '', workflowId: '',
    kind: 'commission-statement',
    orgId: input.orgId,
    commissionStatement: { statementId: input.statementId, subjectId: input.subjectId, period: input.period, total: input.total, currency: input.currency },
    proposal: input.proposal,
    status: 'pending',
    createdAt: nowIso(),
  };
  await approvals.put(approval);
  await indexApproval(approval);
  return approval;
}

/** The pending approval for a statement, or null (per-entity dedup). */
export async function findPendingCommissionStatementApproval(tenantId: string, statementId: string): Promise<PendingApproval | null> {
  return (await listApprovals(tenantId, 'pending')).find((a) => a.kind === 'commission-statement' && a.commissionStatement?.statementId === statementId) ?? null;
}

export type CommissionStatementApprovalHandler = (
  tenantId: string, approvalId: string, outcome: 'approved' | 'rejected', opts: { decidedByUserId?: string; note?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;
let commissionStatementApprovalHandler: CommissionStatementApprovalHandler | null = null;
export function registerCommissionStatementApprovalHandler(fn: CommissionStatementApprovalHandler): void { commissionStatementApprovalHandler = fn; }
export function getCommissionStatementApprovalHandler(): CommissionStatementApprovalHandler | null { return commissionStatementApprovalHandler; }

export async function getApproval(approvalId: string): Promise<PendingApproval | null> {
  return approvals.get(approvalId);
}

/** Tenant-scoped list, newest first; optionally filtered by status.
 *  Indexed (ADR 0029): bounded prefix scan of the (tenant, status) slice →
 *  point gets; the row read is the source of truth (stale rows re-checked). */
/** ADR 0473 — cross-tenant rows of one (kind, status), for the retention-tick
 *  proposal sweep + the transient-GC pending-guard. One scan of the status
 *  index per call; row count is bounded by `pruneResolved` + the per-tenant
 *  caps, and callers run on the (quiet-window) retention tick, never a hot
 *  path. Rows are re-checked against the source of truth (index staleness
 *  tolerated, never trusted) — and a marker whose row is GONE is deleted on
 *  sight (grade-data D2 self-heal: torn-down tenants' markers must not
 *  inflate this scan forever). */
export async function listApprovalsByKindAndStatus(kind: ApprovalKind, status: ApprovalStatus): Promise<PendingApproval[]> {
  const rows = await approvalsByTenantStatus.listByPrefix('');
  const marked = rows.filter((r) => r.ixId.includes(`:${status}:`));
  const fetched = await Promise.all(marked.map(async (r) => {
    const a = await approvals.get(r.approvalId);
    if (a === null) void approvalsByTenantStatus.delete(r.ixId).catch(() => {});
    return a;
  }));
  return fetched.filter((a): a is PendingApproval => a !== null && a.status === status && a.kind === kind);
}

export async function listPendingApprovalsByKind(kind: ApprovalKind): Promise<PendingApproval[]> {
  return listApprovalsByKindAndStatus(kind, 'pending');
}

/** ADR 0473 (grade-data D2) — tenant-teardown purge of the (tenant, status)
 *  index slice. Index rows carry no JSON tenantId, so the generic hostext walk
 *  never reaches them; the tenant IS the key prefix. */
export async function purgeApprovalIndexForTenant(tenantId: string): Promise<number> {
  const rows = await approvalsByTenantStatus.listByPrefix(`${tenantId}:`);
  for (const r of rows) await approvalsByTenantStatus.delete(r.ixId);
  return rows.length;
}

/** ADR 0473 (grade-code C2) — the decide handler's one-put record of a
 *  successful approve: the started run + the LIVE hash it verified. */
export async function attachComposedDecision(approvalId: string, patch: { runId: string; approvedDefinitionHash: string }): Promise<void> {
  const approval = await approvals.get(approvalId);
  if (!approval) return;
  approval.runId = patch.runId;
  if (approval.composedWorkflow) approval.composedWorkflow.approvedDefinitionHash = patch.approvedDefinitionHash;
  await approvals.put(approval);
}

export async function listApprovals(tenantId: string, status?: ApprovalStatus): Promise<PendingApproval[]> {
  const statuses: ApprovalStatus[] = status ? [status] : ['pending', 'approved', 'rejected'];
  const ixRows = (
    await Promise.all(statuses.map((st) => approvalsByTenantStatus.listByPrefix(`${tenantId}:${st}:`)))
  ).flat();
  const fetched = await Promise.all(ixRows.map((r) => approvals.get(r.approvalId)));
  return fetched
    .filter((a): a is PendingApproval => a !== null && a.tenantId === tenantId && (status ? a.status === status : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** True when this card already has a pending approval — used by the heartbeat
 *  to avoid re-proposing the same card on every poll. */
export async function hasPendingApprovalForCard(tenantId: string, cardId: string): Promise<boolean> {
  return (await listApprovals(tenantId, 'pending')).some((a) => a.cardId === cardId);
}

/** ADR 0775 P3b — true when a schedule slot already filed a pending approval
 *  for this job, so later slots do not pile up duplicates. */
export async function hasPendingApprovalForJob(tenantId: string, jobId: string): Promise<boolean> {
  return (await listApprovals(tenantId, 'pending')).some((a) => a.scheduleJobId === jobId);
}

/** True when this CMS page already has a pending content-publish approval —
 *  used by `submit` to avoid fanning out duplicate approvals (ADR 0066). */
export async function hasPendingApprovalForPage(tenantId: string, pageId: string): Promise<boolean> {
  return (await listApprovals(tenantId, 'pending')).some((a) => a.kind === 'content-publish' && a.pageId === pageId);
}

/** The pending content-publish approval for a page, or null (chat-first-port C1).
 *  The CMS `approve`/`reject` header buttons resolve THIS row through the shared
 *  decision core so page-decide ≡ inbox-decide — never a bespoke page transition. */
export async function findPendingContentApprovalForPage(tenantId: string, pageId: string): Promise<PendingApproval | null> {
  return (await listApprovals(tenantId, 'pending')).find((a) => a.kind === 'content-publish' && a.pageId === pageId) ?? null;
}

/**
 * ADR 0593 D4/CMSAU-5 — the page's MOST RECENT content-publish row, whatever its
 * status. `findPendingContentApprovalForPage` answers "is there a review open";
 * this answers "what happened to the last one", which is what the SUBMITTER
 * needs: a rejection used to leave the page silently reading `draft`,
 * indistinguishable from never-submitted, with the note the wire already carried
 * rendered by nobody.
 *
 * Newest-first by `resolvedAt ?? createdAt` so a pending row (always the newest,
 * since there is at most one open per page) sorts above stale resolved ones.
 */
export async function findLatestContentApprovalForPage(tenantId: string, pageId: string): Promise<PendingApproval | null> {
  const mine = (await listApprovals(tenantId)).filter((a) => a.kind === 'content-publish' && a.pageId === pageId);
  if (mine.length === 0) return null;
  const at = (a: PendingApproval): string => a.resolvedAt ?? a.createdAt;
  return mine.reduce((best, a) => (a.status === 'pending' && best.status !== 'pending' ? a
    : best.status === 'pending' ? best
    : at(a) > at(best) ? a : best));
}

/**
 * Re-point an OPEN content-publish approval at the page's current content
 * (UX_UPGRADE-content R2, CMS2-M1). A resubmit of an edited in-review page runs
 * this instead of being dropped as a duplicate.
 *
 * Deliberately narrow: it rewrites only what the row SAYS ABOUT THE PAGE, never
 * `status`, `decidedBy`, `approvals[]` or any decision state — so it cannot be
 * used to un-decide a resolved row or launder an approval. It refuses anything
 * that is not still `pending`, for the same reason.
 */
export async function repinContentApproval(
  approvalId: string,
  patch: {
    pageTitle?: string; pageVersion?: number; proposal?: string; aiDraftedLocales?: string[];
    /** ADR 0859 D3 — UNIONED into the row's submitters, never replacing them. */
    submitters?: string[];
    /** ADR 0859 D4 — UNIONED like `submitters`. */
    submitterCauses?: string[];
    /** ADR 0859 D5 — REPLACES the disclosure (clears it when `[]`), like `aiDraftedLocales`. */
    liveReferenceSections?: Array<{ sectionId: string; type: string }>;
    /** ADR 0861 D6 addendum — REPLACES (clears when `[]`), like `aiDraftedLocales`. */
    outdatedTranslationLocales?: string[];
  },
): Promise<PendingApproval | null> {
  return withApprovalLock(approvalId, async () => {
  const cur = await approvals.get(approvalId);
  if (!cur || cur.kind !== 'content-publish' || cur.status !== 'pending') return null;
  const next: PendingApproval = {
    ...cur,
    ...(patch.pageTitle !== undefined ? { pageTitle: patch.pageTitle } : {}),
    ...(patch.pageVersion !== undefined ? { pageVersion: patch.pageVersion } : {}),
    ...(patch.proposal !== undefined ? { proposal: patch.proposal } : {}),
  };
  // ADR 0593 D4 — a repin REPLACES the provenance set (including clearing it
  // when the machine drafts are gone). An `??=` merge here would be the mirror
  // defect of the one this closes: stale disclosure outliving the content.
  if (patch.aiDraftedLocales !== undefined) {
    if (patch.aiDraftedLocales.length > 0) next.aiDraftedLocales = patch.aiDraftedLocales;
    else delete next.aiDraftedLocales;
  }
  if (patch.liveReferenceSections !== undefined) {
    if (patch.liveReferenceSections.length > 0) next.liveReferenceSections = patch.liveReferenceSections;
    else delete next.liveReferenceSections;
  }
  if (patch.outdatedTranslationLocales !== undefined) {
    if (patch.outdatedTranslationLocales.length > 0) next.outdatedTranslationLocales = patch.outdatedTranslationLocales;
    else delete next.outdatedTranslationLocales;
  }
  if (patch.submitters && patch.submitters.length > 0) {
    next.submitters = [...new Set([...(cur.submitters ?? []), ...patch.submitters])];
  }
  if (patch.submitterCauses && patch.submitterCauses.length > 0) {
    next.submitterCauses = [...new Set([...(cur.submitterCauses ?? []), ...patch.submitterCauses])];
  }
  // ADR 0672 D4 (`CMSAWF-13`) — the pending check above is check-then-act, and this used
  // to `put()` blind: no CAS, and OUTSIDE `withApprovalLock`, while this function's own
  // header promised "it refuses anything that is not still `pending`". A submit/repin
  // interleaving a decide reverted an APPROVED row to pending, erased `resolvedAt` and
  // `decidedBy`, and — because `indexApproval` was called with no `prevStatus`, and it only
  // deletes the old entry when one is supplied — left the row indexed under BOTH statuses.
  // The lock serialises in-process; the CAS makes the refusal true across instances.
  if (!(await approvals.compareAndSwap(cur, next))) return null;
  await indexApproval(next, cur.status);
  return next;
  });
}

/**
 * Refresh a PENDING approval's human-readable `proposal` in place.
 *
 * Added UX_UPGRADE-access-data R2 (CC2-R1). A kind whose approval is reused for
 * identical MATERIAL (commerce listings dedup on a lane+price+url fingerprint)
 * would otherwise keep whatever summary it was created with — so improving what
 * an approver is told reaches only rows queued after the deploy, and every
 * already-pending row stays as blind as before.
 *
 * Deliberately narrow: `proposal` only, `pending` only. It cannot touch decision
 * state, and it must never be used to change WHAT is being approved — that is
 * the material fingerprint's job, and altering it here would slide new content
 * under a reviewer who had already read the old.
 */
export async function setApprovalProposal(approvalId: string, proposal: string): Promise<PendingApproval | null> {
  // ADR 0672 D4 — identical shape to `repinContentApproval`, identical cure: the lock
  // serialises in-process, the CAS makes the pending refusal true across instances, and
  // `prevStatus` stops a status change leaving the row indexed twice.
  return withApprovalLock(approvalId, async () => {
    const cur = await approvals.get(approvalId);
    if (!cur || cur.status !== 'pending' || cur.proposal === proposal) return null;
    const next: PendingApproval = { ...cur, proposal };
    if (!(await approvals.compareAndSwap(cur, next))) return null;
    await indexApproval(next, cur.status);
    return next;
  });
}

/** Resolve an approval (claim → approved, reject → rejected). The `pending`
 *  guard is the lock: `changed` is true only for the call that performed the
 *  pending→resolved transition, so a caller can gate a side effect on it (e.g.
 *  only the winning claim dispatches the run). Returns null if missing.
 *
 *  A7 — the pending→resolved transition is now an atomic compare-and-swap
 *  (`DurableCollection.compareAndSwap` → storage `kvCompareAndSwap`), correct
 *  ACROSS instances: exactly one concurrent claim wins (`changed: true`); the
 *  losers observe the already-resolved row (`changed: false`). The in-process
 *  `withApprovalLock` stays as a same-process fast-path, but the CAS is the hard
 *  guarantee — the previous get→put double-dispatch window is closed. */
export function resolveApproval(
  approvalId: string,
  outcome: {
    status: 'approved' | 'rejected';
    runId?: string;
    note?: string;
    /**
     * ADR 0672 D3 (`CMSAWF-15`) — what the GOVERNANCE chain records, when that differs
     * from the row's `status`.
     *
     * A SUPERSEDING closure resolves the row `'rejected'` because that is the only
     * terminal non-approved state `ApprovalStatus` has — but the review was not rejected,
     * it was overtaken: the page went live by another route, or was deleted, or rolled
     * back. Recording `outcome:'rejected'` against a page that is PUBLISHED makes the
     * tamper-evident chain contradict the thing it audits, which is the one thing it must
     * not do.
     *
     * Chain-only ON PURPOSE. `ApprovalStatus` is a three-value union baked into the
     * secondary-index id and iterated as a 3-tuple by `listApprovals`; a fourth status
     * would force an index migration plus every status consumer. The ROW stays
     * `rejected`; only the audit entry tells the fuller truth.
     */
    chainOutcome?: 'superseded';
    /** ADR 0301 chain-slice enrichment (SCREEN_POLISH admin residue) — the
     *  deciding subject, recorded in the GOVERNANCE_DECISION audit entry as
     *  `actor` so the admin ledger can show actor→before→after. Optional:
     *  system/agent-resolved decisions legitimately have no user actor. */
    decidedBy?: string;
  },
  expectedSnapshot?: PendingApproval,
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  return withApprovalLock(approvalId, async () => {
    if (expectedSnapshot && expectedSnapshot.approvalId !== approvalId) throw new Error('approval_snapshot_id_mismatch');
    const approval = expectedSnapshot ?? await approvals.get(approvalId);
    if (!approval) return null;
    if (approval.status !== 'pending') return { approval, changed: false };
    const next: PendingApproval = {
      ...approval,
      status: outcome.status,
      resolvedAt: nowIso(),
      ...(outcome.chainOutcome === 'superseded' ? { superseded: true } : {}),
      ...(outcome.runId ? { runId: outcome.runId } : {}),
      ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      // ADR 0592 §8 — persist the deciding subject ON the row (it was audit-
      // chain-only), so a reviewer's DSAR can reach their decision attribution
      // + note via the kind redactors. Additive KV field; legacy rows lack it
      // (their notes stay unattributable — disclosed, the CMSLWF-5 legacy
      // -bounded shape).
      ...(outcome.decidedBy ? { decidedBy: outcome.decidedBy } : {}),
    };
    // ADR 0845 STR3CD-4 — a strategy activation's content snapshot exists for the
    // approver to READ while the row is pending (it can be large: 50 objectives × 30
    // KRs). A resolved row keeps the digest it was bound to; the copy of the plan
    // itself is dropped so closed rows do not accumulate it.
    if (next.kind === 'strategy-activation') delete next.strategySnapshot;
    // Atomic: swap only if the row is still exactly the pending one we read.
    const swapped = await approvals.compareAndSwap(approval, next);
    if (!swapped) {
      // Lost the race — another claim resolved it first. Report the resolved state.
      const current = await approvals.get(approvalId);
      return current ? { approval: current, changed: false } : null;
    }
    await indexApproval(next, approval.status);
    // Bound the store: resolved rows accumulate forever otherwise, growing the
    // per-heartbeat scan. Prune the tenant's oldest resolved entries past the cap.
    await pruneResolved(approval.tenantId);
    // ADR 0301 / CDP-F — record the approval decision in the tamper-evident
    // hash-chain (best-effort: never break resolving on an audit-chain failure).
    try {
      await appendAudit(next.tenantId, AUDIT_KIND_GOVERNANCE_DECISION, {
        approvalId: next.approvalId,
        approvalKind: next.kind,
        outcome: outcome.chainOutcome ?? next.status,
        // ADR 0301 slice — actor→before→after. `before` is structurally
        // 'pending' (the CAS only transitions pending rows), recorded
        // explicitly so the chain entry is self-describing.
        before: 'pending',
        ...(outcome.decidedBy ? { actor: outcome.decidedBy } : {}),
        ...(next.runId ? { runId: next.runId } : {}),
        ...(next.note !== undefined ? { note: next.note } : {}),
      });
    } catch (err) {
      auditLog.warn('audit_chain_append_failed', { tenantId: next.tenantId, kind: AUDIT_KIND_GOVERNANCE_DECISION, error: String(err) });
    }
    return { approval: next, changed: true };
  });
}

/** Re-open a just-resolved approval back to `pending` (ADR 0066 compensation).
 *  The content-publish decide path resolves the approval BEFORE the page
 *  transition (the CAS gates the side effect); if the transition then fails
 *  (the page left `in_review`, or was deleted), this restores the approval so a
 *  failed decide never consumes it — the row never lies about what happened.
 *  Idempotent + CAS-guarded; a no-op if the row is already pending/gone. */
export async function reopenApproval(approvalId: string, expectedResolved?: PendingApproval): Promise<void> {
  await withApprovalLock(approvalId, async () => {
    if (expectedResolved && expectedResolved.approvalId !== approvalId) throw new Error('approval_snapshot_id_mismatch');
    const a = expectedResolved ?? await approvals.get(approvalId);
    if (!a || a.status === 'pending') return;
    const { resolvedAt: _resolvedAt, ...rest } = a;
    const reopened: PendingApproval = { ...rest, status: 'pending' };
    const swapped = await approvals.compareAndSwap(a, reopened);
    if (swapped) await indexApproval(reopened, a.status);
  });
}

/** Reject any pending content-publish approval for a page (ADR 0066). Called
 *  when an admin moves the page out of `in_review` through the direct
 *  reject/unpublish routes, so the inbox row doesn't orphan (the page is the single
 *  source of truth for its status).
 *
 *  CORRECTED (ADR 0672 D5) — this used to say "while the approval gate is ON". The
 *  cleanup is UNCONDITIONAL; `routes.ts` says so in terms. Post-ADR 0593 the row is
 *  queued under both toggle states, so a gate-OFF publish strands a row too. */
export async function rejectPendingApprovalForPage(
  tenantId: string,
  pageId: string,
  note: string,
  /**
   * ADR 0672 D3 — `true` when the review was OVERTAKEN rather than declined (a direct
   * publish, a delete, a rollback, a scheduled publish firing). The row still resolves
   * `rejected` — that is the only terminal non-approved state — but the chain records
   * `superseded`, so it cannot say "the review was rejected" about a page that just went
   * live.
   */
  superseded = false,
): Promise<void> {
  const pending = (await listApprovals(tenantId, 'pending')).filter(
    (a) => a.kind === 'content-publish' && a.pageId === pageId,
  );
  for (const a of pending) {
    await resolveApproval(a.approvalId, { status: 'rejected', note, ...(superseded ? { chainOutcome: 'superseded' as const } : {}) });
  }
}

/**
 * ADR 0597 §Correction 4 — close the pending strategy-activation review(s) for a
 * strategy whose PROTECTED content has just been rewritten, so an approver can
 * never activate objectives they never saw.
 *
 * `decideStrategyActivation` enforces "approve what you see" by comparing the
 * strategy's CURRENT status against the `strategyFromStatus` frozen at queue
 * time. That only catches an edit which MOVES THE STATUS — and whether a
 * protected edit moves it is decided by `protectedEditRequiresReapproval`, which
 * is false for `draft` (unapproved) and for the terminal states (`completed` /
 * `archived`, where auto-reverting to draft would hand a plain `workspace:write`
 * holder the un-archive capability `requireConfigAuthority` reserves). So the
 * compare covered exactly one origin, `paused`, and only incidentally.
 *
 * The cure is not to widen the revert (that re-opens the escalation the terminal
 * carve-out correctly refuses) but to withdraw the SUBMISSION: the content under
 * review changed, so there is nothing left to approve. Modelled on
 * `rejectPendingApprovalForPage`. Returns the number closed, so the caller can
 * TELL the owner rather than doing it silently.
 */
export async function closePendingStrategyActivationApprovals(tenantId: string, strategyId: string, note: string): Promise<number> {
  const pending = (await listApprovals(tenantId, 'pending')).filter(
    (a) => a.kind === 'strategy-activation' && a.strategyId === strategyId,
  );
  let closed = 0;
  for (const a of pending) {
    const r = await resolveApproval(a.approvalId, { status: 'rejected', note });
    if (r?.changed) closed += 1;
  }
  return closed;
}

/**
 * R2 DLR2-B3/B4 — close the pending review card(s) for registrations that no longer
 * have a pending decision to make: either the dealer (and its rows) was deleted, or
 * the registration was decided through a lane that bypasses the card. Without this
 * the card is not merely stale, it is UNCLEARABLE — its handler calls
 * `decideRegistration`, which 404s on a deleted row and 409s on a decided one, and
 * the `catch` re-opens the approval, so approve and reject both throw forever.
 *
 * Modelled on `rejectPendingApprovalForPage`. Returns the number closed.
 */
export async function closePendingDealerRegistrationApprovals(
  tenantId: string,
  regIds: readonly string[],
  note: string,
  /**
   * REVIEW B1 — the first version hard-coded `'rejected'` for BOTH decisions, so an
   * APPROVED registration decided outside the inbox recorded "Rejected" on its card AND
   * in the ADR 0301 governance audit chain (`outcome: 'rejected'`, `before: 'pending'`).
   * That fires on the demo seed and on the `approve-registration` workflow node — the
   * default shape, no race needed — and the record of record was provably wrong while
   * the note beside it said "approved". A closed card must state what actually happened.
   */
  outcome: 'approved' | 'rejected' = 'rejected',
  /** …by whom. Omitted, the audit row named nobody for a decision that had an actor. */
  decidedBy?: string,
): Promise<number> {
  if (regIds.length === 0) return 0;
  const wanted = new Set(regIds);
  const pending = (await listApprovals(tenantId, 'pending')).filter(
    (a) => a.kind === 'dealer-registration' && a.dealerRegistration && wanted.has(a.dealerRegistration.regId),
  );
  let closed = 0;
  for (const a of pending) {
    const r = await resolveApproval(a.approvalId, { status: outcome, note, ...(decidedBy ? { decidedBy } : {}) });
    if (r?.changed) closed += 1;
  }
  return closed;
}

/**
 * R2 COM2-M5 — close the pending commission-statement cards for a plan whose draft
 * statements are being deleted. Without this the card is not merely stale, it is
 * unclearable: its handler resolves the statement by id, which 404s once the row is gone,
 * and the compensating `reopenApproval` puts it straight back. Modelled on
 * `rejectPendingApprovalForPage`; returns the number closed.
 */
export async function closePendingCommissionStatementApprovals(tenantId: string, orgId: string, planId: string, note: string): Promise<number> {
  const pending = (await listApprovals(tenantId, 'pending')).filter(
    (a) => a.kind === 'commission-statement' && a.orgId === orgId && a.commissionStatement?.statementId.startsWith(`${planId}:`),
  );
  let closed = 0;
  for (const a of pending) {
    const r = await resolveApproval(a.approvalId, { status: 'rejected', note });
    if (r?.changed) closed += 1;
  }
  return closed;
}

/** Attach the started run to an already-approved approval (post-dispatch). */
export async function attachRunId(approvalId: string, runId: string): Promise<void> {
  const approval = await approvals.get(approvalId);
  if (!approval) return;
  approval.runId = runId;
  await approvals.put(approval);
}

/** Cascade: remove every approval (pending OR resolved) proposed for a roster
 *  member, plus its (tenant, status) index row. Called when the member is
 *  deleted so a now-gone agent leaves no ghost proposal in the inbox and no
 *  stale row in the idempotency index (`hasPendingApprovalForCard`). Returns
 *  the count removed. */
export async function deleteApprovalsForRoster(tenantId: string, rosterId: string): Promise<number> {
  const all = await listApprovals(tenantId);
  let removed = 0;
  for (const a of all) {
    if (a.rosterId !== rosterId) continue;
    await approvals.delete(a.approvalId);
    await approvalsByTenantStatus.delete(approvalIxId(tenantId, a.status, a.approvalId));
    removed += 1;
  }
  return removed;
}

const RESOLVED_RETENTION = 100;
/** ADR 0859 D6 — how many pages may keep their newest review past `RESOLVED_RETENTION`. */
const PAGE_REVIEW_RETENTION = 500;

/** Keep only the most-recent `keep` resolved approvals for a tenant; delete the
 *  rest. Pending approvals are never pruned.
 *
 *  ADR 0859 D6 (`CMSA2WF-4`) — EXCEPT the newest resolved `content-publish` row of each
 *  page. `GET …/pages/:id/review` reads that row to tell the author what happened to
 *  their submission, and the cap is tenant-wide across every kind, so on a busy tenant
 *  a rejection's reason vanished before its author read it. One row per reviewed page
 *  is the bound; `deleteResolvedContentApprovalsForPage` drops them with the page. */
async function pruneResolved(tenantId: string, keep = RESOLVED_RETENTION): Promise<void> {
  const resolved = (
    await Promise.all([listApprovals(tenantId, 'approved'), listApprovals(tenantId, 'rejected')])
  )
    .flat()
    .sort((a, b) => (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt));
  // Bounded (code grade CMSA2CD-2): at most PAGE_REVIEW_RETENTION pages keep a row
  // beyond the cap, newest first — otherwise a tenant's resolved set grew with every
  // page ever reviewed, and every resolve, review read and page delete scans it.
  const latestPerPage = new Set<string>();
  const seenPages = new Set<string>();
  for (const a of resolved) {
    if (latestPerPage.size >= PAGE_REVIEW_RETENTION) break;
    if (a.kind !== 'content-publish' || !a.pageId || seenPages.has(a.pageId)) continue;
    seenPages.add(a.pageId);
    latestPerPage.add(a.approvalId);
  }
  for (const stale of resolved.slice(keep)) {
    if (latestPerPage.has(stale.approvalId)) continue;
    await approvals.delete(stale.approvalId);
    await approvalsByTenantStatus.delete(approvalIxId(tenantId, stale.status, stale.approvalId));
  }
}

/** ADR 0859 D6 — a deleted page keeps no review rows. Called by the CMS page delete
 *  AFTER it has closed the page's pending row (the closure is on the governance chain,
 *  which is the durable audit; these rows only served the page's own review read).
 *  Returns how many rows went. */
export async function deleteResolvedContentApprovalsForPage(tenantId: string, pageId: string): Promise<number> {
  let removed = 0;
  for (const a of await listApprovals(tenantId)) {
    if (a.kind !== 'content-publish' || a.pageId !== pageId || a.status === 'pending') continue;
    await approvals.delete(a.approvalId);
    await approvalsByTenantStatus.delete(approvalIxId(tenantId, a.status, a.approvalId));
    removed += 1;
  }
  return removed;
}

/** Test-only: drop all approvals. */
export async function __resetApprovalStore(): Promise<void> {
  await approvals.__clear();
  await approvalsByTenantStatus.__clear();
}
