/**
 * Shared workflow-template pack (ADR 0032 Phase 2.0).
 *
 * The reusable workflow building blocks the ten enterprise work-twins
 * (ADR 0032; `new_agents.md` "shared workflow-template library") compose,
 * rather than re-implementing the same flows ten times. A twin's per-role
 * workflow binds a template by id through `core.subWorkflow`
 * (`config.workflowId`), so the eleven template categories below are authored
 * once and shared.
 *
 * ── Why a pinned in-tree catalog, NOT the in-memory builder registry ──
 * These definitions are a **pinned pack**: a module-level constant resolved by
 * the workflow catalog at boot (wired in `host/index.ts` as a catalog source
 * AHEAD of `workflowsRegistry`). That mirrors the `exampleWorkflows.ts` precedent
 * and is deliberate:
 *   - `workflowsRegistry` (populated via `POST /v1/host/openwop-app/workflows`) is
 *     process-local and evicted on restart — a twin portfolio that bound a
 *     template id there would 404 after a redeploy and break `:fork` replay
 *     (the definition would no longer resolve).
 *   - A pinned constant is runnable on every instance, survives restart, and is
 *     byte-stable, so a historical run re-resolves the SAME definition on
 *     replay/fork (ARCHITECTURE.md §"Keep replay and fork deterministic").
 * The RFC 0028 prompt-pack loader (`promptPackLoader.ts`) is prompt-only; there
 * is no on-disk workflow-pack loader in this sample, so the idiomatic "pinned"
 * home for shared workflow definitions is an in-tree module like this one.
 *
 * Every node typeId here is an already-registered core/demo node — no new I/O
 * node is authored (the templates are deterministic graphs of `mock-ai` logic
 * steps, `core.approvalGate` human gates, and `core.subWorkflow` composition).
 * Per ADR 0032 the twins run at draft/recommend autonomy day 1, so every
 * side-effecting flow routes through an approval gate.
 */

import type { EdgeDef, WorkflowDefinition } from '../executor/types.js';

/** The reusable template families from the `new_agents.md` library table. */
export type WorkflowTemplateCategory =
  | 'meeting-ops'
  | 'reporting'
  | 'intake-triage'
  | 'scheduling'
  | 'approvals'
  | 'knowledge'
  | 'people'
  | 'finance'
  | 'commercial'
  | 'it'
  | 'comms';

export const WORKFLOW_TEMPLATE_CATEGORIES: readonly WorkflowTemplateCategory[] = [
  'meeting-ops',
  'reporting',
  'intake-triage',
  'scheduling',
  'approvals',
  'knowledge',
  'people',
  'finance',
  'commercial',
  'it',
  'comms',
];

/** A reusable workflow template: a runnable id + business-friendly metadata +
 *  the deterministic node graph, mirroring `ExampleWorkflowSpec`. */
export interface WorkflowTemplateSpec {
  /** Backend-resolvable id, `tmpl.<category>.<name>` — what a twin binds via
   *  `core.subWorkflow.config.workflowId`. */
  workflowId: string;
  /** Business-friendly name (no raw ids in first-use UI, per the PRD copy rule). */
  name: string;
  /** One-line "what this template does". */
  purpose: string;
  category: WorkflowTemplateCategory;
  /** The deterministic node graph the run executes. */
  definition: WorkflowDefinition;
}

// ── node typeIds (all already registered in bootstrap/nodes.ts) ──
const AI = 'local.sample.demo.mock-ai';
const APPROVAL = 'core.approvalGate';
const SUBFLOW = 'core.subWorkflow';

/** Build linear `e1..eN` edges connecting consecutive node ids. */
function linearEdges(nodeIds: readonly string[]): EdgeDef[] {
  const edges: EdgeDef[] = [];
  for (let i = 1; i < nodeIds.length; i++) {
    edges.push({ edgeId: `e${i}`, sourceNodeId: nodeIds[i - 1]!, targetNodeId: nodeIds[i]! });
  }
  return edges;
}

type NodeSpec = { nodeId: string; typeId: string; config?: Record<string, unknown> };

/** Assemble a linear workflow from node specs; the last node is the canonical
 *  (RFC 0065 `primary`) deliverable. */
function linear(workflowId: string, specs: readonly NodeSpec[]): WorkflowDefinition {
  const nodes = specs.map((s, i) => ({
    nodeId: s.nodeId,
    typeId: s.typeId,
    ...(s.config ? { config: s.config } : {}),
    ...(i === specs.length - 1 ? { outputRole: 'primary' as const } : {}),
  }));
  return { workflowId, nodes, edges: linearEdges(specs.map((s) => s.nodeId)) };
}

/** A pure draft/summarize/classify flow: one or more `mock-ai` logic steps. */
function draftFlow(workflowId: string, steps: readonly string[]): WorkflowDefinition {
  return linear(workflowId, steps.map((nodeId) => ({ nodeId, typeId: AI })));
}

/** A human-gated flow: a prep step, one or more `core.approvalGate`s, then an
 *  apply step. Side-effecting twin flows use this (draft/recommend day-1). */
function gatedFlow(
  workflowId: string,
  opts: { prep: string; gates: ReadonlyArray<{ nodeId: string; config: Record<string, unknown> }>; apply: string },
): WorkflowDefinition {
  const specs: NodeSpec[] = [
    { nodeId: opts.prep, typeId: AI },
    ...opts.gates.map((g) => ({ nodeId: g.nodeId, typeId: APPROVAL, config: g.config })),
    { nodeId: opts.apply, typeId: AI },
  ];
  return linear(workflowId, specs);
}

/** A composed flow: bind a CHILD template via `core.subWorkflow`, then a
 *  follow-up `mock-ai` step over the child's result. Demonstrates the
 *  twin→template composition seam intra-pack. */
function composedFlow(
  workflowId: string,
  opts: { bindNodeId: string; childWorkflowId: string; thenNodeId: string },
): WorkflowDefinition {
  return linear(workflowId, [
    { nodeId: opts.bindNodeId, typeId: SUBFLOW, config: { workflowId: opts.childWorkflowId, waitForCompletion: true, onChildFailure: 'fail-parent' } },
    { nodeId: opts.thenNodeId, typeId: AI },
  ]);
}

/** The pinned template catalog — 11 categories × 4 templates. */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplateSpec[] = [
  // ── Meeting operations ──
  { workflowId: 'tmpl.meeting-ops.meeting-brief', name: 'Meeting brief', purpose: 'Assemble a pre-meeting brief from context.', category: 'meeting-ops', definition: draftFlow('tmpl.meeting-ops.meeting-brief', ['gather-context', 'draft-brief']) },
  { workflowId: 'tmpl.meeting-ops.attendee-dossier', name: 'Attendee dossier', purpose: 'Build per-attendee background for a meeting.', category: 'meeting-ops', definition: draftFlow('tmpl.meeting-ops.attendee-dossier', ['resolve-attendees', 'draft-dossier']) },
  { workflowId: 'tmpl.meeting-ops.action-extraction', name: 'Action extraction', purpose: 'Extract action items from meeting notes.', category: 'meeting-ops', definition: draftFlow('tmpl.meeting-ops.action-extraction', ['read-notes', 'extract-actions']) },
  { workflowId: 'tmpl.meeting-ops.post-meeting-follow-up', name: 'Post-meeting follow-up', purpose: 'Extract actions, then draft a follow-up.', category: 'meeting-ops', definition: composedFlow('tmpl.meeting-ops.post-meeting-follow-up', { bindNodeId: 'extract', childWorkflowId: 'tmpl.meeting-ops.action-extraction', thenNodeId: 'draft-follow-up' }) },

  // ── Reporting and reviews ──
  { workflowId: 'tmpl.reporting.daily-summary', name: 'Daily summary', purpose: 'Summarize the day across signals.', category: 'reporting', definition: draftFlow('tmpl.reporting.daily-summary', ['collect-signals', 'draft-summary']) },
  { workflowId: 'tmpl.reporting.weekly-business-review', name: 'Weekly business review', purpose: 'Aggregate the week into a WBR.', category: 'reporting', definition: draftFlow('tmpl.reporting.weekly-business-review', ['aggregate-week', 'draft-wbr']) },
  { workflowId: 'tmpl.reporting.monthly-scorecard', name: 'Monthly scorecard', purpose: 'Compute and narrate monthly metrics.', category: 'reporting', definition: draftFlow('tmpl.reporting.monthly-scorecard', ['compute-metrics', 'draft-scorecard']) },
  { workflowId: 'tmpl.reporting.quarterly-retrospective', name: 'Quarterly retrospective', purpose: 'Synthesize a quarterly retro.', category: 'reporting', definition: draftFlow('tmpl.reporting.quarterly-retrospective', ['gather-quarter', 'draft-retro']) },

  // ── Intake and triage ──
  { workflowId: 'tmpl.intake-triage.request-classification', name: 'Request classification', purpose: 'Classify an inbound request.', category: 'intake-triage', definition: draftFlow('tmpl.intake-triage.request-classification', ['classify']) },
  { workflowId: 'tmpl.intake-triage.priority-routing', name: 'Priority routing', purpose: 'Score priority and route.', category: 'intake-triage', definition: draftFlow('tmpl.intake-triage.priority-routing', ['score-priority', 'route']) },
  { workflowId: 'tmpl.intake-triage.required-field-completion', name: 'Required-field completion', purpose: 'Detect and request missing fields.', category: 'intake-triage', definition: draftFlow('tmpl.intake-triage.required-field-completion', ['detect-missing', 'request-fields']) },
  { workflowId: 'tmpl.intake-triage.escalation-routing', name: 'Escalation routing', purpose: 'Assess severity, confirm, then notify.', category: 'intake-triage', definition: gatedFlow('tmpl.intake-triage.escalation-routing', { prep: 'assess-severity', gates: [{ nodeId: 'confirm-escalation', config: { prompt: 'Confirm escalation', title: 'Escalate this request?' } }], apply: 'notify-escalation' }) },

  // ── Scheduling ──
  { workflowId: 'tmpl.scheduling.availability-match', name: 'Availability match', purpose: 'Propose slots from calendars.', category: 'scheduling', definition: draftFlow('tmpl.scheduling.availability-match', ['read-calendars', 'propose-slots']) },
  { workflowId: 'tmpl.scheduling.hold-creation', name: 'Hold creation', purpose: 'Find a slot, confirm, then place a hold.', category: 'scheduling', definition: gatedFlow('tmpl.scheduling.hold-creation', { prep: 'find-slot', gates: [{ nodeId: 'confirm-hold', config: { prompt: 'Confirm calendar hold', title: 'Place this hold?' } }], apply: 'place-hold' }) },
  { workflowId: 'tmpl.scheduling.prep-reminders', name: 'Prep reminders', purpose: 'Compose a prep reminder.', category: 'scheduling', definition: draftFlow('tmpl.scheduling.prep-reminders', ['compose-reminder']) },
  { workflowId: 'tmpl.scheduling.no-response-chase', name: 'No-response chase', purpose: 'Detect a stalled thread and draft a chase.', category: 'scheduling', definition: draftFlow('tmpl.scheduling.no-response-chase', ['detect-no-response', 'draft-chase']) },

  // ── Approvals (the canonical gate templates) ──
  { workflowId: 'tmpl.approvals.single-approver', name: 'Single approver', purpose: 'One human approval before apply.', category: 'approvals', definition: gatedFlow('tmpl.approvals.single-approver', { prep: 'prepare', gates: [{ nodeId: 'approve', config: { prompt: 'Approve this action', title: 'Approval required' } }], apply: 'apply' }) },
  { workflowId: 'tmpl.approvals.dual-approver', name: 'Dual approver', purpose: 'Two sequential approvals before apply.', category: 'approvals', definition: gatedFlow('tmpl.approvals.dual-approver', { prep: 'prepare', gates: [{ nodeId: 'approve-1', config: { prompt: 'First approval', title: 'Approval 1 of 2' } }, { nodeId: 'approve-2', config: { prompt: 'Second approval', title: 'Approval 2 of 2' } }], apply: 'apply' }) },
  { workflowId: 'tmpl.approvals.manager-plus-compliance', name: 'Manager plus compliance', purpose: 'Manager then compliance approval.', category: 'approvals', definition: gatedFlow('tmpl.approvals.manager-plus-compliance', { prep: 'prepare', gates: [{ nodeId: 'manager-approval', config: { prompt: 'Manager approval', title: 'Manager sign-off' } }, { nodeId: 'compliance-approval', config: { prompt: 'Compliance approval', title: 'Compliance sign-off' } }], apply: 'apply' }) },
  { workflowId: 'tmpl.approvals.threshold-based', name: 'Threshold-based approval', purpose: 'Quorum approval (requiredApprovals) before apply.', category: 'approvals', definition: gatedFlow('tmpl.approvals.threshold-based', { prep: 'prepare', gates: [{ nodeId: 'quorum-approval', config: { prompt: 'Quorum approval', title: 'Threshold approval', requiredApprovals: 2 } }], apply: 'apply' }) },

  // ── Knowledge work ──
  { workflowId: 'tmpl.knowledge.source-pack-assembly', name: 'Source pack assembly', purpose: 'Retrieve and assemble a source pack.', category: 'knowledge', definition: draftFlow('tmpl.knowledge.source-pack-assembly', ['retrieve-sources', 'assemble-pack']) },
  { workflowId: 'tmpl.knowledge.comparison-summary', name: 'Comparison summary', purpose: 'Compare items into a summary.', category: 'knowledge', definition: draftFlow('tmpl.knowledge.comparison-summary', ['gather-items', 'draft-comparison']) },
  { workflowId: 'tmpl.knowledge.faq-update', name: 'FAQ update', purpose: 'Detect gaps and draft FAQ updates.', category: 'knowledge', definition: draftFlow('tmpl.knowledge.faq-update', ['detect-gaps', 'draft-faq-update']) },
  { workflowId: 'tmpl.knowledge.policy-summarization', name: 'Policy summarization', purpose: 'Summarize a policy document.', category: 'knowledge', definition: draftFlow('tmpl.knowledge.policy-summarization', ['read-policy', 'summarize-policy']) },

  // ── People workflows ──
  { workflowId: 'tmpl.people.onboarding-checklist', name: 'Onboarding checklist', purpose: 'Build an onboarding checklist.', category: 'people', definition: draftFlow('tmpl.people.onboarding-checklist', ['build-onboarding']) },
  { workflowId: 'tmpl.people.offboarding-checklist', name: 'Offboarding checklist', purpose: 'Build offboarding, confirm, then execute.', category: 'people', definition: gatedFlow('tmpl.people.offboarding-checklist', { prep: 'build-offboarding', gates: [{ nodeId: 'confirm-offboarding', config: { prompt: 'Confirm offboarding', title: 'Approve offboarding?' } }], apply: 'execute-offboarding' }) },
  { workflowId: 'tmpl.people.manager-nudge', name: 'Manager nudge', purpose: 'Compose a manager nudge.', category: 'people', definition: draftFlow('tmpl.people.manager-nudge', ['compose-nudge']) },
  { workflowId: 'tmpl.people.leave-request-routing', name: 'Leave-request routing', purpose: 'Assess leave, manager approval, then record.', category: 'people', definition: gatedFlow('tmpl.people.leave-request-routing', { prep: 'assess-leave', gates: [{ nodeId: 'manager-approval', config: { prompt: 'Approve leave request', title: 'Leave approval' } }], apply: 'record-leave' }) },

  // ── Finance workflows ──
  { workflowId: 'tmpl.finance.close-checklist', name: 'Close checklist', purpose: 'Build the period-close checklist.', category: 'finance', definition: draftFlow('tmpl.finance.close-checklist', ['build-close-checklist']) },
  { workflowId: 'tmpl.finance.support-collection', name: 'Support collection', purpose: 'Identify and request missing support.', category: 'finance', definition: draftFlow('tmpl.finance.support-collection', ['identify-missing-support', 'request-support']) },
  { workflowId: 'tmpl.finance.variance-note-draft', name: 'Variance-note draft', purpose: 'Compute variance and draft a note.', category: 'finance', definition: draftFlow('tmpl.finance.variance-note-draft', ['compute-variance', 'draft-note']) },
  { workflowId: 'tmpl.finance.approval-chase', name: 'Approval chase', purpose: 'Run a single-approver gate, then chase if pending.', category: 'finance', definition: composedFlow('tmpl.finance.approval-chase', { bindNodeId: 'request-approval', childWorkflowId: 'tmpl.approvals.single-approver', thenNodeId: 'draft-chase' }) },

  // ── Commercial workflows ──
  { workflowId: 'tmpl.commercial.account-brief', name: 'Account brief', purpose: 'Assemble an account brief.', category: 'commercial', definition: draftFlow('tmpl.commercial.account-brief', ['gather-account', 'draft-brief']) },
  { workflowId: 'tmpl.commercial.next-step-draft', name: 'Next-step draft', purpose: 'Assess stage and draft the next step.', category: 'commercial', definition: draftFlow('tmpl.commercial.next-step-draft', ['assess-stage', 'draft-next-step']) },
  { workflowId: 'tmpl.commercial.renewal-pack', name: 'Renewal pack', purpose: 'Assemble a renewal pack.', category: 'commercial', definition: draftFlow('tmpl.commercial.renewal-pack', ['gather-renewal', 'assemble-pack']) },
  { workflowId: 'tmpl.commercial.risk-digest', name: 'Risk digest', purpose: 'Scan and digest account risk.', category: 'commercial', definition: draftFlow('tmpl.commercial.risk-digest', ['scan-risk', 'draft-digest']) },

  // ── IT workflows ──
  { workflowId: 'tmpl.it.incident-triage', name: 'Incident triage', purpose: 'Classify and route an incident.', category: 'it', definition: draftFlow('tmpl.it.incident-triage', ['classify-incident', 'route-incident']) },
  { workflowId: 'tmpl.it.kb-recommendation', name: 'KB recommendation', purpose: 'Match and recommend a KB article.', category: 'it', definition: draftFlow('tmpl.it.kb-recommendation', ['match-kb', 'recommend']) },
  { workflowId: 'tmpl.it.standard-request-routing', name: 'Standard request routing', purpose: 'Classify a request, confirm, then fulfill.', category: 'it', definition: gatedFlow('tmpl.it.standard-request-routing', { prep: 'classify-request', gates: [{ nodeId: 'confirm-provision', config: { prompt: 'Confirm provisioning', title: 'Approve standard request?' } }], apply: 'route-fulfillment' }) },
  { workflowId: 'tmpl.it.major-incident-update', name: 'Major-incident update', purpose: 'Gather status and draft an update.', category: 'it', definition: draftFlow('tmpl.it.major-incident-update', ['gather-status', 'draft-update']) },

  // ── Communications ──
  { workflowId: 'tmpl.comms.announcement-draft', name: 'Announcement draft', purpose: 'Draft an announcement.', category: 'comms', definition: draftFlow('tmpl.comms.announcement-draft', ['gather-inputs', 'draft-announcement']) },
  { workflowId: 'tmpl.comms.audience-adaptation', name: 'Audience adaptation', purpose: 'Adapt a message to an audience.', category: 'comms', definition: draftFlow('tmpl.comms.audience-adaptation', ['analyze-audience', 'adapt-message']) },
  { workflowId: 'tmpl.comms.faq-draft', name: 'FAQ draft', purpose: 'Draft an FAQ from questions.', category: 'comms', definition: draftFlow('tmpl.comms.faq-draft', ['gather-questions', 'draft-faq']) },
  { workflowId: 'tmpl.comms.all-hands-prep', name: 'All-hands prep', purpose: 'Collect topics and draft an agenda.', category: 'comms', definition: draftFlow('tmpl.comms.all-hands-prep', ['collect-topics', 'draft-agenda']) },
];

const BY_ID = new Map<string, WorkflowTemplateSpec>(WORKFLOW_TEMPLATES.map((t) => [t.workflowId, t]));

/** Resolve a pinned template definition by id (catalog source). Null = absent. */
export function getWorkflowTemplate(workflowId: string): WorkflowDefinition | null {
  return BY_ID.get(workflowId)?.definition ?? null;
}

/** All template specs (UI/catalog listing). */
export function listWorkflowTemplates(): readonly WorkflowTemplateSpec[] {
  return WORKFLOW_TEMPLATES;
}

/** Template specs in one category. */
export function listWorkflowTemplatesByCategory(category: WorkflowTemplateCategory): WorkflowTemplateSpec[] {
  return WORKFLOW_TEMPLATES.filter((t) => t.category === category);
}
