/**
 * The Work-Twin shared workflow-template library (ADR 0032 Phase 2.0), as
 * workflow-chain pack registrations (ADR 0775 P2).
 *
 * The ten enterprise work-twins (ADR 0032) bind these `tmpl.<category>.<name>`
 * ids in their standing portfolios (`seed-data/exampleAgents.json`) and compose
 * them through `core.subWorkflow`. The definitions used to be a pinned in-tree
 * catalog in this module, resolved by id in catalog source A. That is the shape
 * CLAUDE.md "Workflows — never hard-code" forbids (`ARWF-1`), so ADR 0775 P2
 * moved all 44 into the `vendor.openwop-app.workflows.work-twin-templates`
 * chain pack (`examples/workflow-chain-packs/work-twin-templates/`) in three
 * batches, and deleted the catalog.
 *
 * What is left here is registration only: the id list, the boot call, and the
 * `postProcess` that keeps each expansion byte-identical to the definition it
 * replaced, so every historical run's `definitionRevision` pin still matches
 * (`test/work-twin-template-chains.test.ts`). No definition can be written
 * here: `registerChainBackedWorkflow` accepts only a chain id (ADR 0472).
 *
 * Every chain is `internal` (RFC 0135): out of the `/builder` gallery, the `/`
 * picker and the zero-config tenant seed. They are deterministic mock-AI demo
 * flows kept as replay archives, per the user's decision of 2026-10-10 on the
 * ADR 0775 P2 reachability question. Real-AI Work-Twin chains are a separate ADR.
 */

import type { WorkflowDefinition } from '../executor/types.js';
import { registerChainBackedWorkflow } from './chainBackedWorkflows.js';

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

/**
 * The full library — 11 categories × 4 — in the order the batches migrated it
 * (ADR 0775 P2a/P2b/P2c). Each id is registered chain-backed same-id at boot
 * from the `work-twin-templates` chain pack; there is no in-tree definition
 * any more (`test/workflow-templates.test.ts`).
 */
export const WORKFLOW_TEMPLATE_CHAIN_IDS: readonly string[] = [
  // P2a — meeting-ops, reporting, intake-triage, scheduling (16).
  'tmpl.meeting-ops.meeting-brief',
  'tmpl.meeting-ops.attendee-dossier',
  'tmpl.meeting-ops.action-extraction',
  'tmpl.meeting-ops.post-meeting-follow-up',
  'tmpl.reporting.daily-summary',
  'tmpl.reporting.weekly-business-review',
  'tmpl.reporting.monthly-scorecard',
  'tmpl.reporting.quarterly-retrospective',
  'tmpl.intake-triage.request-classification',
  'tmpl.intake-triage.priority-routing',
  'tmpl.intake-triage.required-field-completion',
  'tmpl.intake-triage.escalation-routing',
  'tmpl.scheduling.availability-match',
  'tmpl.scheduling.hold-creation',
  'tmpl.scheduling.prep-reminders',
  'tmpl.scheduling.no-response-chase',
  // P2b — approvals, knowledge, people, finance (16; approval-chase composes single-approver).
  'tmpl.approvals.single-approver',
  'tmpl.approvals.dual-approver',
  'tmpl.approvals.manager-plus-compliance',
  'tmpl.approvals.threshold-based',
  'tmpl.knowledge.source-pack-assembly',
  'tmpl.knowledge.comparison-summary',
  'tmpl.knowledge.faq-update',
  'tmpl.knowledge.policy-summarization',
  'tmpl.people.onboarding-checklist',
  'tmpl.people.offboarding-checklist',
  'tmpl.people.manager-nudge',
  'tmpl.people.leave-request-routing',
  'tmpl.finance.close-checklist',
  'tmpl.finance.support-collection',
  'tmpl.finance.variance-note-draft',
  'tmpl.finance.approval-chase',
  // P2c — commercial, it, comms (12).
  'tmpl.commercial.account-brief',
  'tmpl.commercial.next-step-draft',
  'tmpl.commercial.renewal-pack',
  'tmpl.commercial.risk-digest',
  'tmpl.it.incident-triage',
  'tmpl.it.kb-recommendation',
  'tmpl.it.standard-request-routing',
  'tmpl.it.major-incident-update',
  'tmpl.comms.announcement-draft',
  'tmpl.comms.audience-adaptation',
  'tmpl.comms.faq-draft',
  'tmpl.comms.all-hands-prep',
];

const MOCK_ARCHIVE_IDS: ReadonlySet<string> = new Set(WORKFLOW_TEMPLATE_CHAIN_IDS);

/**
 * ADR 0963 D8 — whether `workflowId` is one of the 44 Work-Twin mock-AI
 * archives above. They "do work" by fabricating it (`local.sample.demo.mock-ai`,
 * ADR 0939 § Context), so the autonomous work loop must never run or propose
 * one on its own: the user paused their schedules for exactly that reason
 * (ADR 0939). Keyed on THIS list — the SSoT the pack registration uses — never
 * on a `tmpl.` prefix guess.
 */
export function isWorkTwinMockArchive(workflowId: string | undefined): boolean {
  return workflowId !== undefined && MOCK_ARCHIVE_IDS.has(workflowId);
}

/**
 * ADR 0775 P2 (the replay note) — restore a migrated template's expansion to the
 * EXACT pre-migration definition. `expandChain` prefixes every node id
 * (`<chain>_<expansionId>_<id>`) and adds `metadata` + `configurableSchema`; the
 * in-tree definition had bare node ids and neither field. A run created before
 * the migration carries `definitionRevision = revisionHashOf(<in-tree def>)` and
 * checkpoints keyed by BARE node id, so anything but byte identity would make a
 * `:fork` hydrate against nodes that no longer exist. With identity, the revision
 * this registration records IS the historical pin, so those runs resolve
 * `resolvedFrom: 'revision'`.
 *
 * The cost, accepted: the definition does not carry `metadata.expandedFrom.nodePins`,
 * so `runInsert`'s node-pin-mismatch stamp has nothing to compare for these demo
 * workflows. The pins still live in the pack and are enforced at load (ADR 0766).
 * The chains take no parameters, so no `variables[]` or aliases are lost.
 */
export function restoreTemplateShape(def: WorkflowDefinition): void {
  const expansionId = (def.metadata as { expansionId?: unknown } | undefined)?.expansionId;
  if (typeof expansionId !== 'string') throw new Error(`template chain '${def.workflowId}' expanded without an expansionId`);
  const prefix = `${def.workflowId.replace(/\./g, '_')}_${expansionId}_`;
  const bare = (id: string): string => {
    if (!id.startsWith(prefix)) throw new Error(`template chain '${def.workflowId}': node id '${id}' lacks the expansion prefix`);
    return id.slice(prefix.length);
  };
  for (const node of def.nodes) node.nodeId = bare(node.nodeId);
  for (const edge of def.edges ?? []) {
    edge.sourceNodeId = bare(edge.sourceNodeId);
    edge.targetNodeId = bare(edge.targetNodeId);
  }
  if ((def.variables ?? []).length > 0) throw new Error(`template chain '${def.workflowId}' declares variables; restoreTemplateShape would drop them`);
  delete def.variables;
  delete def.metadata;
  delete (def as { configurableSchema?: unknown }).configurableSchema;
}

/** ADR 0775 P2 — register every migrated template chain-backed, same id. Called
 *  once at boot from `registerBackendFeatures`, after the chain packs load and
 *  before the CBW-1 sub-chain bind sweep. */
export function registerWorkflowTemplateChains(): void {
  for (const id of WORKFLOW_TEMPLATE_CHAIN_IDS) {
    registerChainBackedWorkflow(id, { postProcess: restoreTemplateShape });
  }
}
