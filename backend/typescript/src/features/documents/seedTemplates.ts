/**
 * Built-in starter template catalog (ADR 0053 — resolves the "Seeded template
 * library" open question). A code-versioned, host-global, READ-ONLY set of starter
 * document templates (the `workflowTemplates.ts` precedent) for the canonical
 * business-document kinds. Users INSTANTIATE a starter into their org as an
 * editable `documents:template` row (`from-catalog`) — the catalog itself is never
 * mutated and is not per-tenant state.
 *
 * Markdown-first: starters intentionally carry NO `outputSchema` so the
 * generate-from-template node produces free-form Markdown (structured-output mode
 * is only engaged when a template author supplies an explicit schema).
 */

import type { DocFormat, TemplateParams } from './documentsService.js';

export interface SeedTemplate {
  /** Stable catalog id (`seed.<kind>`), referenced by the from-catalog route. */
  catalogId: string;
  name: string;
  kind: string;
  outputFormat: DocFormat;
  /** Generator body — `{{param}}` placeholders filled at assemble time. */
  promptBody: string;
  parameters: TemplateParams;
}

const p = (required: string[], properties: TemplateParams['properties']): TemplateParams => ({ required, properties });

export const SEED_TEMPLATES: readonly SeedTemplate[] = [
  {
    catalogId: 'seed.sow',
    name: 'Statement of Work (SOW)',
    kind: 'sow',
    outputFormat: 'markdown',
    promptBody:
      'Write a professional Statement of Work in Markdown.\n\n' +
      'Client: {{client}}\nEngagement: {{engagement}}\nScope summary: {{scope}}\n' +
      'Timeline: {{timeline}}\nFees / rate: {{fees}}\n\n' +
      'Include these sections, each with concrete content (state an assumption explicitly ' +
      'where a detail was not provided — never invent client commitments): Overview, ' +
      'Objectives, Scope of Work, Deliverables, Timeline & Milestones, Pricing & Payment ' +
      'Terms, Assumptions, Out of Scope, Acceptance Criteria, Change Control.',
    parameters: p(['client', 'scope'], {
      client: { type: 'string', description: 'Client / customer name' },
      engagement: { type: 'string', description: 'Short engagement title' },
      scope: { type: 'string', description: 'What the work covers' },
      timeline: { type: 'string', description: 'Overall timeline / key dates' },
      fees: { type: 'string', description: 'Pricing model or rate' },
    }),
  },
  {
    catalogId: 'seed.prd',
    name: 'Product Requirements Document (PRD)',
    kind: 'prd',
    outputFormat: 'markdown',
    promptBody:
      'Write a Product Requirements Document in Markdown.\n\n' +
      'Product / feature: {{feature}}\nProblem: {{problem}}\nTarget users: {{users}}\n' +
      'Success metrics: {{metrics}}\n\n' +
      'Include: Problem Statement, Goals, Non-Goals, Target Users & Use Cases, ' +
      'User Stories, Functional Requirements, Non-Functional Requirements, Success ' +
      'Metrics, Risks & Open Questions, Milestones. Be specific and testable.',
    parameters: p(['feature', 'problem'], {
      feature: { type: 'string', description: 'Product or feature name' },
      problem: { type: 'string', description: 'The problem being solved' },
      users: { type: 'string', description: 'Primary user segments' },
      metrics: { type: 'string', description: 'How success is measured' },
    }),
  },
  {
    catalogId: 'seed.rfp',
    name: 'Request for Proposal (RFP)',
    kind: 'rfp',
    outputFormat: 'markdown',
    promptBody:
      'Write a Request for Proposal in Markdown.\n\n' +
      'Issuing organization: {{org}}\nProject: {{project}}\nBudget range: {{budget}}\n' +
      'Submission deadline: {{deadline}}\n\n' +
      'Include: Introduction & Background, Project Objectives, Scope of Requirements, ' +
      'Vendor Qualifications, Proposal Requirements, Evaluation Criteria (with weights), ' +
      'Timeline & Submission Instructions, Terms & Conditions. Keep requirements clear ' +
      'and unambiguous so vendors can respond comparably.',
    parameters: p(['org', 'project'], {
      org: { type: 'string', description: 'Issuing organization' },
      project: { type: 'string', description: 'Project / procurement title' },
      budget: { type: 'string', description: 'Budget range (optional)' },
      deadline: { type: 'string', description: 'Submission deadline' },
    }),
  },
  {
    catalogId: 'seed.epic-brief',
    name: 'Epic Brief',
    kind: 'epic-brief',
    outputFormat: 'markdown',
    promptBody:
      'Write a concise Epic Brief in Markdown.\n\n' +
      'Epic: {{epic}}\nOutcome: {{outcome}}\nScope: {{scope}}\n\n' +
      'Include: Summary, Desired Outcome, Scope, Milestones, Dependencies, Risks, ' +
      'Definition of Done. Keep it tight — one page of substance.',
    parameters: p(['epic', 'outcome'], {
      epic: { type: 'string', description: 'Epic name' },
      outcome: { type: 'string', description: 'The outcome this epic delivers' },
      scope: { type: 'string', description: 'What is in scope' },
    }),
  },
  {
    catalogId: 'seed.board-agenda',
    name: 'Board Meeting Agenda',
    kind: 'board-agenda',
    outputFormat: 'markdown',
    promptBody:
      'Write a Board Meeting Agenda in Markdown.\n\n' +
      'Organization: {{org}}\nMeeting date: {{date}}\nKey topics: {{topics}}\n\n' +
      'Produce a structured agenda: header (org, date, attendees placeholder), then ' +
      'numbered agenda items — for each: objective, owner, time-box, and whether a ' +
      'decision is sought. Close with Pre-Reads and Action-Item Review sections.',
    parameters: p(['org', 'date'], {
      org: { type: 'string', description: 'Organization / board name' },
      date: { type: 'string', description: 'Meeting date' },
      topics: { type: 'string', description: 'Comma-separated key topics' },
    }),
  },
  {
    // Binds the pack-declared `doc.one-pager` artifact type (core.openwop.artifact-types):
    // instantiating this seed auto-binds `doc.${kind}` = `doc.one-pager`, so the
    // generate node emits a typed `artifact.created` (ADR 0055) — the producer that
    // makes the pack-declared type live.
    catalogId: 'seed.one-pager',
    name: 'One-Pager',
    kind: 'one-pager',
    outputFormat: 'markdown',
    promptBody:
      'Write a crisp one-page brief in Markdown — everything fits on a single page.\n\n' +
      'Title: {{title}}\nAudience: {{audience}}\nThe ask / goal: {{goal}}\n' +
      'Key context: {{context}}\n\n' +
      'Produce: a one-line summary, then tight sections — Problem, Proposal, Why now, ' +
      'Impact / success metrics, Asks / next steps. Be concise and concrete; state an ' +
      'assumption explicitly where a detail was not provided. No filler.',
    parameters: p(['title', 'goal'], {
      title: { type: 'string', description: 'One-pager title' },
      audience: { type: 'string', description: 'Who it is for' },
      goal: { type: 'string', description: 'The ask / decision sought' },
      context: { type: 'string', description: 'Key background' },
    }),
  },
];

/** The read-only starter catalog (optionally filtered by kind). */
export function listSeedTemplates(kind?: string): readonly SeedTemplate[] {
  return kind ? SEED_TEMPLATES.filter((t) => t.kind === kind) : SEED_TEMPLATES;
}

export function getSeedTemplate(catalogId: string): SeedTemplate | undefined {
  return SEED_TEMPLATES.find((t) => t.catalogId === catalogId);
}
