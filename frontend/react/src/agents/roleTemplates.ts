/**
 * Role templates + workflow display metadata for the "AI coworkers" UX.
 *
 * Mirrors the backend's built-in example catalog (host/exampleWorkflows.ts): the
 * runnable workflow ids and their business-friendly names. The UI shows the
 * friendly names — raw ids stay out of first-use surfaces (PRD §16). Used by
 * the agent dashboard, workspace portfolio, and the create-agent wizard.
 *
 * Keep in sync with apps/.../backend/typescript/src/host/exampleWorkflows.ts.
 */

import type { CSSProperties } from 'react';
import {
  ActivityIcon,
  BotIcon,
  BriefcaseIcon,
  BuildingIcon,
  FileTextIcon,
  LifeBuoyIcon,
  SparklesIcon,
  MegaphoneIcon,
  ScaleIcon,
  UserIcon,
  WrenchIcon,
} from '../ui/icons/index.js';

export interface WorkflowOption {
  workflowId: string;
  name: string;
  purpose: string;
}

export interface RoleTemplate {
  key: string;
  /** Suggested role title for the wizard. */
  title: string;
  /** Short blurb shown on the role picker. */
  blurb: string;
  /** A persona-shaping default system prompt the wizard pre-fills. */
  personaPrompt: string;
  workflows: WorkflowOption[];
}

// ADR 0032 — the create-agent wizard offers the ten canonical Enterprise Digital
// Work Twins (the legacy demo roles were retired with the legacy-5 seed removal,
// T2.A). Chief of Staff (= Iris) is the live `assistant` agent and is created via
// its own path (ADR 0023), so it is not a wizard template. Each role binds the
// shared `tmpl.*` workflow library (T2.0 / host/workflowTemplates.ts) — the
// `personaPrompt` here is a wizard PRE-FILL the user edits, distinct from the
// authoritative seed systemPrompt the backend owns (T2.A / exampleAgents.json).
export const ROLE_TEMPLATES: ReadonlyArray<RoleTemplate> = [
  {
    key: 'sales-execution',
    title: 'Sales Execution',
    blurb: 'Briefs accounts, drafts next steps, digests pipeline risk.',
    personaPrompt:
      'You are a Sales Execution twin. You are pipeline-aware and concise. You assemble account briefs, draft the next step on an opportunity, and digest account risk for review.',
    workflows: [
      { workflowId: 'tmpl.commercial.account-brief', name: 'Account brief', purpose: 'Assemble an account brief.' },
      { workflowId: 'tmpl.commercial.next-step-draft', name: 'Next-step draft', purpose: 'Assess stage and draft the next step.' },
      { workflowId: 'tmpl.commercial.risk-digest', name: 'Risk digest', purpose: 'Scan and digest account risk.' },
    ],
  },
  {
    key: 'customer-success',
    title: 'Customer Success',
    blurb: 'Assembles renewal packs, digests account health, briefs accounts.',
    personaPrompt:
      'You are a Customer Success twin. You are retention-focused and proactive. You assemble renewal packs, digest account-health risk, and prep account briefs.',
    workflows: [
      { workflowId: 'tmpl.commercial.renewal-pack', name: 'Renewal pack', purpose: 'Assemble a renewal pack.' },
      { workflowId: 'tmpl.commercial.risk-digest', name: 'Risk digest', purpose: 'Scan and digest account risk.' },
      { workflowId: 'tmpl.commercial.account-brief', name: 'Account brief', purpose: 'Assemble an account brief.' },
    ],
  },
  {
    key: 'finance-close',
    title: 'Finance Close',
    blurb: 'Runs the close checklist, chases support, drafts variance notes.',
    personaPrompt:
      'You are a Finance Close twin. You are careful and audit-friendly. You run the period-close checklist, collect missing support, and draft variance notes — always gating risky changes for approval.',
    workflows: [
      { workflowId: 'tmpl.finance.close-checklist', name: 'Close checklist', purpose: 'Build the period-close checklist.' },
      { workflowId: 'tmpl.finance.support-collection', name: 'Support collection', purpose: 'Identify and request missing support.' },
      { workflowId: 'tmpl.finance.variance-note-draft', name: 'Variance-note draft', purpose: 'Compute variance and draft a note.' },
      { workflowId: 'tmpl.finance.approval-chase', name: 'Approval chase', purpose: 'Run a single-approver gate, then chase if pending.' },
    ],
  },
  {
    key: 'it-service-desk',
    title: 'IT Service Desk',
    blurb: 'Triages incidents, recommends KB articles, routes standard requests.',
    personaPrompt:
      'You are an IT Service Desk twin. You are calm and methodical. You triage incidents, recommend KB articles, and route standard requests — confirming before any provisioning.',
    workflows: [
      { workflowId: 'tmpl.it.incident-triage', name: 'Incident triage', purpose: 'Classify and route an incident.' },
      { workflowId: 'tmpl.it.kb-recommendation', name: 'KB recommendation', purpose: 'Match and recommend a KB article.' },
      { workflowId: 'tmpl.it.standard-request-routing', name: 'Standard request routing', purpose: 'Classify a request, confirm, then fulfill.' },
      { workflowId: 'tmpl.it.major-incident-update', name: 'Major-incident update', purpose: 'Gather status and draft an update.' },
    ],
  },
  {
    key: 'internal-comms',
    title: 'Internal Communications',
    blurb: 'Drafts announcements, adapts messaging, preps all-hands.',
    personaPrompt:
      'You are an Internal Communications twin. You are clear and audience-aware. You draft announcements, adapt messaging per audience, and prep all-hands agendas.',
    workflows: [
      { workflowId: 'tmpl.comms.announcement-draft', name: 'Announcement draft', purpose: 'Draft an announcement.' },
      { workflowId: 'tmpl.comms.audience-adaptation', name: 'Audience adaptation', purpose: 'Adapt a message to an audience.' },
      { workflowId: 'tmpl.comms.faq-draft', name: 'FAQ draft', purpose: 'Draft an FAQ from questions.' },
      { workflowId: 'tmpl.comms.all-hands-prep', name: 'All-hands prep', purpose: 'Collect topics and draft an agenda.' },
    ],
  },
  {
    key: 'recruiting-coordinator',
    title: 'Recruiting Coordinator',
    blurb: 'Matches availability, places interview holds, preps onboarding.',
    personaPrompt:
      'You are a Recruiting Coordinator twin. You are responsive and organized. You match interviewer availability, place calendar holds, and prep onboarding checklists.',
    workflows: [
      { workflowId: 'tmpl.scheduling.availability-match', name: 'Availability match', purpose: 'Propose slots from calendars.' },
      { workflowId: 'tmpl.scheduling.hold-creation', name: 'Hold creation', purpose: 'Find a slot, confirm, then place a hold.' },
      { workflowId: 'tmpl.people.onboarding-checklist', name: 'Onboarding checklist', purpose: 'Build an onboarding checklist.' },
    ],
  },
  {
    key: 'people-ops',
    title: 'People Operations',
    blurb: 'Builds on/offboarding, routes leave, nudges managers.',
    personaPrompt:
      'You are a People Operations twin. You are discreet and policy-aware. You build onboarding/offboarding checklists, route leave requests for approval, and nudge managers on open items.',
    workflows: [
      { workflowId: 'tmpl.people.onboarding-checklist', name: 'Onboarding checklist', purpose: 'Build an onboarding checklist.' },
      { workflowId: 'tmpl.people.offboarding-checklist', name: 'Offboarding checklist', purpose: 'Build offboarding, confirm, then execute.' },
      { workflowId: 'tmpl.people.leave-request-routing', name: 'Leave-request routing', purpose: 'Assess leave, manager approval, then record.' },
      { workflowId: 'tmpl.people.manager-nudge', name: 'Manager nudge', purpose: 'Compose a manager nudge.' },
    ],
  },
  {
    key: 'contract-procurement',
    title: 'Contract & Procurement',
    blurb: 'Summarizes clauses, compares terms, routes approvals.',
    personaPrompt:
      'You are a Contract & Procurement twin. You are precise and risk-aware. You summarize policies and clauses, compare terms, and route contracts through the right approval chain.',
    workflows: [
      { workflowId: 'tmpl.knowledge.policy-summarization', name: 'Policy summarization', purpose: 'Summarize a policy document.' },
      { workflowId: 'tmpl.knowledge.comparison-summary', name: 'Comparison summary', purpose: 'Compare items into a summary.' },
      { workflowId: 'tmpl.approvals.manager-plus-compliance', name: 'Manager plus compliance', purpose: 'Manager then compliance approval.' },
    ],
  },
  {
    key: 'executive-ops',
    title: 'Executive Operations',
    blurb: 'Preps meetings, extracts actions, drafts daily/weekly summaries.',
    personaPrompt:
      'You are an Executive Operations twin. You run the executive operating rhythm: prep meeting briefs, extract and follow up on actions, and draft daily and weekly summaries.',
    workflows: [
      { workflowId: 'tmpl.meeting-ops.meeting-brief', name: 'Meeting brief', purpose: 'Assemble a pre-meeting brief from context.' },
      { workflowId: 'tmpl.meeting-ops.post-meeting-follow-up', name: 'Post-meeting follow-up', purpose: 'Extract actions, then draft a follow-up.' },
      { workflowId: 'tmpl.reporting.daily-summary', name: 'Daily summary', purpose: 'Summarize the day across signals.' },
      { workflowId: 'tmpl.reporting.weekly-business-review', name: 'Weekly business review', purpose: 'Aggregate the week into a WBR.' },
    ],
  },
];

const WF_BY_ID = new Map<string, WorkflowOption>(
  ROLE_TEMPLATES.flatMap((r) => r.workflows).map((w) => [w.workflowId, w]),
);

/** Friendly display name for a workflow id; falls back to the raw id when it is
 *  not a known built-in (e.g. a user's own registered workflow). */
export function workflowName(workflowId: string): string {
  return WF_BY_ID.get(workflowId)?.name ?? workflowId;
}

export function workflowPurpose(workflowId: string): string | undefined {
  return WF_BY_ID.get(workflowId)?.purpose;
}

/** True when the id is one of the built-in runnable example workflows (vs a
 *  local-only/unregistered workflow that needs registration to run). */
export function isKnownWorkflow(workflowId: string): boolean {
  return WF_BY_ID.has(workflowId);
}

export const ALL_WORKFLOW_OPTIONS: ReadonlyArray<WorkflowOption> = ROLE_TEMPLATES.flatMap((r) => r.workflows);

// ---------------------------------------------------------------------------
// Role theming — give each role a distinct Lucide glyph so a dashboard of 5+
// coworkers reads at a glance. Differentiation is by ICON only (no per-role
// colour): DESIGN.md §3 reserves the functional/accent palette for run
// state, so a role accent would fight the editorial discipline. The clay
// avatar stays uniform; the glyph inside it carries the role.
// ---------------------------------------------------------------------------

type IconComponent = (props: { size?: number; strokeWidth?: number; style?: CSSProperties }) => JSX.Element;

export interface RoleTheme {
  key: string;
  /** Human label for the role family (e.g. "Sales", "Support"). */
  label: string;
  Icon: IconComponent;
}

const ROLE_THEMES: Record<string, RoleTheme> = {
  // ADR 0023 (corrected) — the Chief of Staff is a real roster agent; its
  // theme glyph is the sparkles mark the assistant has always carried.
  'chief-of-staff': { key: 'chief-of-staff', label: 'Chief of Staff', Icon: SparklesIcon },
  // ADR 0032 — the ten canonical Enterprise Digital Work Twins. Each new roleKey
  // gets a distinct glyph so a seeded roster reads at a glance (the seeder stamps
  // RosterEntry.roleKey → roleThemeForKey resolves the glyph). Icon-only
  // differentiation per DESIGN.md §3 (no per-role colour). Chief of Staff (=Iris)
  // is above; Executive Operations rides the same assistant surface (ADR 0032
  // §Exec-vs-Iris) but is a distinct roster instance, so it carries its own glyph.
  'sales-execution': { key: 'sales-execution', label: 'Sales Execution', Icon: BriefcaseIcon },
  'customer-success': { key: 'customer-success', label: 'Customer Success', Icon: LifeBuoyIcon },
  'finance-close': { key: 'finance-close', label: 'Finance Close', Icon: ScaleIcon },
  'it-service-desk': { key: 'it-service-desk', label: 'IT Service Desk', Icon: WrenchIcon },
  'internal-comms': { key: 'internal-comms', label: 'Internal Comms', Icon: MegaphoneIcon },
  'recruiting-coordinator': { key: 'recruiting-coordinator', label: 'Recruiting', Icon: UserIcon },
  'people-ops': { key: 'people-ops', label: 'People Ops', Icon: BuildingIcon },
  'contract-procurement': { key: 'contract-procurement', label: 'Contract & Procurement', Icon: FileTextIcon },
  'executive-ops': { key: 'executive-ops', label: 'Executive Ops', Icon: ActivityIcon },
};

const CUSTOM_THEME: RoleTheme = { key: 'custom', label: 'Custom', Icon: BotIcon };

/** Map a role-template key (or anything) to its theme; unknown → the custom (Bot) theme. */
export function roleThemeForKey(key: string | undefined): RoleTheme {
  return (key && ROLE_THEMES[key]) || CUSTOM_THEME;
}

/** Derive the role-template key for a roster member: prefer the seeded
 *  `host:<example|demo>-<key>` agentRef, else infer from the workflow portfolio,
 *  else fall back to the custom theme. Mirrors host/exampleDataSeed.ts agentRef
 *  ids. (Legacy `host:demo-` refs from earlier demo tenants stay supported.) */
export function roleKeyForAgent(
  agentId: string | undefined,
  workflows: ReadonlyArray<string>,
  explicitRoleKey?: string,
): string {
  // The persisted seed roleKey (RosterEntry.roleKey) wins — exact, not inferred.
  if (explicitRoleKey && ROLE_THEMES[explicitRoleKey]) return explicitRoleKey;
  if (agentId) {
    const m = /^host:(?:example|demo)-(.+)$/.exec(agentId);
    const key = m?.[1];
    if (key && ROLE_THEMES[key]) return key;
  }
  // Infer from the portfolio: the template whose workflows overlap the most.
  let best: { key: string; hits: number } | null = null;
  for (const t of ROLE_TEMPLATES) {
    const ids = new Set(t.workflows.map((w) => w.workflowId));
    const hits = workflows.reduce((n, w) => n + (ids.has(w) ? 1 : 0), 0);
    if (hits > 0 && (!best || hits > best.hits)) best = { key: t.key, hits };
  }
  return best?.key ?? 'custom';
}

/** Convenience: theme for a roster member. */
export function roleThemeForAgent(
  agentId: string | undefined,
  workflows: ReadonlyArray<string>,
  explicitRoleKey?: string,
): RoleTheme {
  return roleThemeForKey(roleKeyForAgent(agentId, workflows, explicitRoleKey));
}
