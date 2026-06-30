/**
 * Insights & Drafting meta-workflows — ADR 0082 (rebuilt ON the workflow engine).
 *
 * Three pinned built-in WorkflowDefinitions (registered via
 * `insightsSuiteFeature.builtinWorkflows`, resolved in catalog source A). ADR 0082 replaced
 * every `local.sample.demo.mock-ai` placeholder with REAL nodes — a Workday HCM source
 * (`core.workday.query`), a BYOK LLM (`core.ai.chatCompletion`), the BigQuery source,
 * deterministic compute, the email-draft (never-sends), and notification-push. The "insight"
 * is the LIVE output of running these against real (BYOK-connected) sources, surfaced through
 * the existing runs / artifacts / chat / notification surfaces — NOT a bespoke dashboard.
 *
 * All typeIds are real + registered (closed-world valid); nodes fail closed at execute
 * without live connectors/BYOK, so the definitions load + validate without credentials.
 * `triggerRule` is PER-EDGE fan-in semantics. Launch via chat / builder / scheduler (RFC
 * 0052) / trigger ingestion (RFC 0099) — all existing surfaces.
 */

import type { WorkflowDefinition } from '../../executor/types.js';

export const WEEKLY_VARIANCE_ID = 'openwop-app.insights.weekly-variance';
export const ANNIVERSARY_DRAFT_ID = 'openwop-app.insights.anniversary-draft';
export const TALENT_PREP_ID = 'openwop-app.insights.talent-prep';

// Real, registered typeIds. ADR 0082 — every `mock-ai` placeholder is gone (the talent +
// drafting flows were fake); these are real source/analysis/LLM/draft/notify nodes.
const BIGQUERY_QUERY = 'core.bigquery.query';
const WORKDAY_QUERY = 'core.workday.query'; // real HCM source (replaces mock-ai `scan`)
const VARIANCE_COMPUTE = 'feature.insights-suite.nodes.variance-compute';
const TALENT_SCORE = 'feature.insights-suite.nodes.talent-score';
const CHAT_COMPLETION = 'core.ai.chatCompletion'; // real BYOK LLM (drafts the recognition body)
const APPROVAL_GATE = 'core.approvalGate';
const DOCUMENTS_RENDER = 'feature.documents.nodes.render';
const NOTIFICATION_PUSH = 'core.openwop.integration.notification-push';
const EMAIL_DRAFT = 'core.email.draft';
const KNOWLEDGE_RETRIEVE = 'knowledge.retrieve';

/** Scheduled (weekly): pull financials read-only from the data lake → compute Actual-vs-Plan
 *  → human sign-off gate → render the summary PDF → notify the principal. The variance is the
 *  run's node output (surfaced in run-detail/artifacts + the notification), not a dashboard. */
export const weeklyVarianceDefinition: WorkflowDefinition = {
  workflowId: WEEKLY_VARIANCE_ID,
  nodes: [
    { nodeId: 'query', typeId: BIGQUERY_QUERY },
    { nodeId: 'compute', typeId: VARIANCE_COMPUTE },
    { nodeId: 'redteam', typeId: APPROVAL_GATE, config: { title: 'Variance red-team', prompt: 'Confirm the variance figures before surfacing.', requiredApprovals: 1, rejectionPolicy: 'block' } },
    { nodeId: 'render', typeId: DOCUMENTS_RENDER, outputRole: 'secondary' },
    { nodeId: 'notify', typeId: NOTIFICATION_PUSH, outputRole: 'primary' },
  ],
  edges: [
    { edgeId: 'e_query_compute', sourceNodeId: 'query', targetNodeId: 'compute' },
    { edgeId: 'e_compute_redteam', sourceNodeId: 'compute', targetNodeId: 'redteam', triggerRule: 'all_success' },
    { edgeId: 'e_redteam_render', sourceNodeId: 'redteam', targetNodeId: 'render', triggerRule: 'all_success' },
    { edgeId: 'e_render_notify', sourceNodeId: 'render', targetNodeId: 'notify', triggerRule: 'all_success' },
  ],
  variables: [
    { name: 'projectId', type: 'string', description: 'BigQuery project for the financials read.', required: false },
    { name: 'businessUnit', type: 'string', description: 'Business unit to analyze.', required: false },
  ],
  metadata: { kind: 'meta-workflow', feature: 'insights-suite' },
};

/** Triggered (Workday work-anniversary): pull upcoming milestones from Workday → retrieve the
 *  principal's voice exemplars → LLM drafts the recognition message → save it as an email DRAFT
 *  (never sends) → human approval → notify "you have N drafts to review". Every step is real. */
export const anniversaryDraftDefinition: WorkflowDefinition = {
  workflowId: ANNIVERSARY_DRAFT_ID,
  nodes: [
    // INS-4 — the Workday resource is parameterizable via the `workdayResource` variable
    // (wired to the node's `resource` input, which overrides config). `config.resource`
    // remains the guaranteed default so the default behaviour (serviceDates) never regresses
    // even if no variable value is threaded.
    { nodeId: 'milestones', typeId: WORKDAY_QUERY, config: { resource: 'serviceDates' }, inputs: { resource: { type: 'variable', variableName: 'workdayResource' } } },
    { nodeId: 'retrieve', typeId: KNOWLEDGE_RETRIEVE },
    { nodeId: 'generate', typeId: CHAT_COMPLETION, config: { provider: 'anthropic', model: 'claude-sonnet-4-6', systemPrompt: 'Draft a warm, specific work-anniversary recognition message in the principal’s voice, grounded in the retrieved exemplars and the milestone. Plain text, no salutation block.' }, outputRole: 'secondary' },
    { nodeId: 'emailDraft', typeId: EMAIL_DRAFT, outputRole: 'primary' },
    { nodeId: 'approve', typeId: APPROVAL_GATE, config: { title: 'Approve draft', prompt: 'Review the recognition draft. It is a DRAFT only — nothing is sent.', requiredApprovals: 1 } },
    { nodeId: 'notify', typeId: NOTIFICATION_PUSH },
  ],
  edges: [
    { edgeId: 'e_milestones_retrieve', sourceNodeId: 'milestones', targetNodeId: 'retrieve', triggerRule: 'all_success' },
    { edgeId: 'e_retrieve_generate', sourceNodeId: 'retrieve', targetNodeId: 'generate', triggerRule: 'all_success' },
    { edgeId: 'e_generate_email', sourceNodeId: 'generate', targetNodeId: 'emailDraft', triggerRule: 'all_success' },
    { edgeId: 'e_email_approve', sourceNodeId: 'emailDraft', targetNodeId: 'approve', triggerRule: 'all_success' },
    { edgeId: 'e_approve_notify', sourceNodeId: 'approve', targetNodeId: 'notify', triggerRule: 'all_success' },
  ],
  variables: [
    { name: 'subjectId', type: 'string', description: 'The person being recognized.', required: false },
    { name: 'milestone', type: 'string', description: 'The anniversary/milestone.', required: false },
    { name: 'workdayResource', type: 'string', description: 'Workday resource the trigger reads — defaults to serviceDates; override for other milestone types (e.g. promotionDates).', required: false, defaultValue: 'serviceDates' },
  ],
  metadata: { kind: 'meta-workflow', feature: 'insights-suite' },
};

/** On-demand / scheduled: pull performance data from Workday → 9-box readiness score →
 *  notify. The score is the run output (surfaced in run-detail + the notification). */
export const talentPrepDefinition: WorkflowDefinition = {
  workflowId: TALENT_PREP_ID,
  nodes: [
    { nodeId: 'pull', typeId: WORKDAY_QUERY, config: { resource: 'performanceReviews' } },
    { nodeId: 'score', typeId: TALENT_SCORE, outputRole: 'primary' },
    { nodeId: 'notify', typeId: NOTIFICATION_PUSH },
  ],
  edges: [
    { edgeId: 'e_pull_score', sourceNodeId: 'pull', targetNodeId: 'score', triggerRule: 'all_success' },
    { edgeId: 'e_score_notify', sourceNodeId: 'score', targetNodeId: 'notify', triggerRule: 'all_success' },
  ],
  variables: [
    { name: 'subjectId', type: 'string', description: 'The person to score.', required: false },
  ],
  metadata: { kind: 'meta-workflow', feature: 'insights-suite' },
};

// ADR 0082 — the mock-ai dual-critic "template" was DELETED (three `local.sample.demo.mock-ai`
// nodes = exactly the fake surface this redesign removes). Red-team / consensus, if wanted, is
// the real agents driving a workflow through the existing chat + the `core.approvalGate` gate,
// not mock nodes.
export const insightsBuiltinWorkflows: readonly WorkflowDefinition[] = [
  weeklyVarianceDefinition,
  anniversaryDraftDefinition,
  talentPrepDefinition,
];
