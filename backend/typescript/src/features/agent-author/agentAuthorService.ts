/**
 * Agent Author service (ADR 0514 P1) — describe-to-create for the digital
 * workforce, as the Workflow Architect shape: a closed-world catalog the model
 * authors against, a validator whose errors feed ONE bounded repair, and a
 * persist that rides the SAME `createRosterEntry` path the 5-step wizard uses
 * (no parallel creation lane).
 *
 * No parallel architecture: agents come from the executor agent registry
 * filtered by the ONE tenant-visibility rule (`agentVisibleToTenant`,
 * ADR 0379); workflow ids from the tenant-honest authored-workflow index
 * (`listAuthoredWorkflows` — it encapsulates the ADR 0163 hiding rule, so we
 * import it rather than re-derive it); persistence through
 * `host/rosterService.createRosterEntry` (deterministic ids, duplicate-409,
 * CAS-guarded).
 *
 * @see docs/adr/0514-agent-author-describe-to-create.md
 */

import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { agentVisibleToTenant } from '../../host/agentVisibility.js';
import { createRosterEntry, listRoster } from '../../host/rosterService.js';
import { listAuthoredWorkflows } from '../workflow-author/workflowAuthorService.js';

export const AUTONOMY_LEVELS = ['auto', 'guided', 'review'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export interface AgentAuthorCatalog {
  /** Installed agents this tenant may reference as `agentRef.agentId`. */
  agents: Array<{ agentId: string; label?: string; description?: string }>;
  /** The tenant's runnable workflow ids for the new agent's portfolio. */
  workflows: Array<{ workflowId: string; name?: string; description?: string }>;
  /** The current roster (read-before-write: persona collisions are 409s). */
  roster: Array<{ rosterId: string; persona: string; roleKey?: string }>;
  autonomyLevels: readonly AutonomyLevel[];
}

export interface AgentDraft {
  persona: string;
  agentId: string;
  label?: string;
  description?: string;
  roleKey?: string;
  autonomyLevel?: AutonomyLevel;
  workflows?: string[];
}

export interface DraftValidation {
  ok: boolean;
  errors: string[];
}

export async function buildAgentAuthorCatalog(opts: { tenantId: string }): Promise<AgentAuthorCatalog> {
  const reg = getAgentRegistry();
  const agents = reg.list()
    .filter((a) => agentVisibleToTenant(a, opts.tenantId))
    .map((a) => ({
      agentId: a.agentId,
      ...(a.label ? { label: a.label } : {}),
      ...(a.description ? { description: a.description } : {}),
    }));
  const workflows = (await listAuthoredWorkflows({ tenantId: opts.tenantId })).map((w) => ({
    workflowId: w.workflowId,
    ...(w.name ? { name: w.name } : {}),
    ...(w.description ? { description: w.description } : {}),
  }));
  const roster = (await listRoster(opts.tenantId)).map((r) => ({
    rosterId: r.rosterId,
    persona: r.persona,
    ...(r.roleKey !== undefined ? { roleKey: r.roleKey } : {}),
  }));
  return { agents, workflows, roster, autonomyLevels: AUTONOMY_LEVELS };
}

/** Coerce unknown input into a draft shape, collecting shape errors instead of
 *  throwing — the errors feed the model's ONE bounded repair. */
function coerceDraft(value: unknown, errors: string[]): AgentDraft {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const persona = typeof v.persona === 'string' ? v.persona.trim() : '';
  if (!persona) errors.push('`persona` is required and must be a non-empty string (the agent’s display name).');
  const agentId = typeof v.agentId === 'string' ? v.agentId.trim() : '';
  if (!agentId) errors.push('`agentId` is required — pick one from the catalog’s `agents` list.');
  const autonomyLevel = v.autonomyLevel;
  if (autonomyLevel !== undefined && !AUTONOMY_LEVELS.includes(autonomyLevel as AutonomyLevel)) {
    errors.push(`\`autonomyLevel\` must be one of ${AUTONOMY_LEVELS.join(' | ')}.`);
  }
  const workflows = Array.isArray(v.workflows) ? v.workflows.filter((w): w is string => typeof w === 'string') : undefined;
  if (Array.isArray(v.workflows) && workflows && workflows.length !== v.workflows.length) {
    errors.push('`workflows` must be an array of workflow-id strings.');
  }
  return {
    persona,
    agentId,
    ...(typeof v.label === 'string' && v.label.trim() ? { label: v.label.trim() } : {}),
    ...(typeof v.description === 'string' && v.description.trim() ? { description: v.description.trim() } : {}),
    ...(typeof v.roleKey === 'string' && v.roleKey.trim() ? { roleKey: v.roleKey.trim() } : {}),
    ...(autonomyLevel === 'guided' || autonomyLevel === 'review' || autonomyLevel === 'auto' ? { autonomyLevel } : {}),
    ...(workflows ? { workflows } : {}),
  };
}

/** Closed-world validation. Every error is actionable model-facing text. */
export async function validateAgentDraft(value: unknown, opts: { tenantId: string }): Promise<DraftValidation & { draft: AgentDraft }> {
  const errors: string[] = [];
  const draft = coerceDraft(value, errors);
  if (draft.agentId) {
    const visible = getAgentRegistry().list().filter((a) => agentVisibleToTenant(a, opts.tenantId));
    if (!visible.some((a) => a.agentId === draft.agentId)) {
      errors.push(`\`agentId\` "${draft.agentId}" is not in the catalog — call get and pick a listed agent.`);
    }
  }
  if (draft.workflows && draft.workflows.length > 0) {
    const known = new Set((await listAuthoredWorkflows({ tenantId: opts.tenantId })).map((w) => w.workflowId));
    for (const w of draft.workflows) {
      if (!known.has(w)) errors.push(`workflow "${w}" does not resolve in this workspace — use ids from the catalog’s \`workflows\` list.`);
    }
  }
  if (draft.persona) {
    // ADR 0379 collision semantics: the deterministic id means a duplicate
    // persona is a 409 at persist — say so at validate time instead.
    const roster = await listRoster(opts.tenantId);
    if (roster.some((r) => r.persona.toLowerCase() === draft.persona.toLowerCase())) {
      errors.push(`persona "${draft.persona}" already exists on the roster — choose a distinct name or revise the existing agent instead.`);
    }
  }
  return { ok: errors.length === 0, errors, draft };
}

/** Validate then create through the SHARED wizard path. The created agent
 *  lands `enabled: false` — the draft-never-auto-activate consensus (ADR 0514
 *  §4): a human reviews and enables it in the workspace. */
export async function persistAgentDraft(value: unknown, opts: { tenantId: string }): Promise<{ rosterId: string; persona: string }> {
  const v = await validateAgentDraft(value, opts);
  if (!v.ok) {
    const err = new Error(`Draft is not valid: ${v.errors.join(' ')}`);
    (err as Error & { code?: string }).code = 'validation_error';
    throw err;
  }
  const entry = await createRosterEntry({
    tenantId: opts.tenantId,
    persona: v.draft.persona,
    agentRef: { agentId: v.draft.agentId },
    enabled: false,
    ...(v.draft.label !== undefined ? { label: v.draft.label } : {}),
    ...(v.draft.description !== undefined ? { description: v.draft.description } : {}),
    ...(v.draft.roleKey !== undefined ? { roleKey: v.draft.roleKey } : {}),
    ...(v.draft.autonomyLevel !== undefined ? { autonomyLevel: v.draft.autonomyLevel } : {}),
    ...(v.draft.workflows !== undefined ? { workflows: v.draft.workflows } : {}),
  });
  return { rosterId: entry.rosterId, persona: entry.persona };
}
