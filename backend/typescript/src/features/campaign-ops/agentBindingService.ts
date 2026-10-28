/**
 * ADR 0943 D2 — per-client agent bindings. A chain names a DEFAULT agent per
 * agent-runner node (its pin); a client of the agency may replace that agent,
 * and optionally its model, without forking the chain. The replacement is
 * frozen into each run at start (`agentBindingContributor`), so a later edit
 * never changes a run that already exists, and `:fork` reads the source's map.
 *
 * Keyed by the PINNED agent id, never by a role name, so no role vocabulary
 * enters code (David's law: agent capability is core, not named). One row per
 * scope: `bindingId` is a hash of (pin, workflowId?, nodeId?), so a second write
 * to the same scope is an update.
 *
 * Writes are closed-world (422 `agent_binding_invalid`): both agents resolve in
 * the tenant, the replacement is not paused, its effective tool allowlist covers
 * the pinned agent's, and a pinned key is a stored BYOK secret of this tenant.
 *
 * @see docs/adr/0943-campaign-agent-team-and-node-assignment.md
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { cleanString } from '../../host/boundedStrings.js';
import { OpenwopError } from '../../types.js';
import { resolveAgentIdentity } from '../../host/agentIdentity.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { effectiveToolAllowlist, resolveAgentToolAllowlistOverride } from '../../host/agentToolAllowlistService.js';
import { listSelectableProviderIds } from '../../providers/catalog.js';
import { isManagedRef } from '../../aiProviders/credentialRefLadder.js';
import { listSecretRefs, resolveSecret } from '../../byok/secretResolver.js';
import { registerCredentialRefConsumer } from '../../host/credentialRefRegistry.js';
import { getClient } from './clientService.js';
import type { ClientAgentBinding } from './types.js';

const bindings = new DurableCollection<ClientAgentBinding>(
  'campaign-ops:agent-binding',
  (b) => `${b.tenantId}::${b.orgId}::${b.bindingId}`,
  undefined,
  (b) => b.tenantId,
);

const ID_MAX = 200;
const MODEL_MAX = 200;
const REF_PATTERN = /^[a-zA-Z0-9_.\-:]{1,128}$/;
const nowIso = (): string => new Date().toISOString();

/** The one id of a binding scope. JSON keeps the parts unambiguous. */
export function bindingIdOf(pinnedAgentId: string, workflowId?: string, nodeId?: string): string {
  const digest = createHash('sha256').update(JSON.stringify([pinnedAgentId, workflowId ?? null, nodeId ?? null])).digest('hex');
  return `agb_${digest.slice(0, 24)}`;
}

function invalid(message: string, reason: string, field?: string): OpenwopError {
  return new OpenwopError('validation_error', message, 422, { reason: 'agent_binding_invalid', detail: reason, ...(field ? { field } : {}) });
}

function idField(raw: unknown, field: string, required: boolean): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw invalid(`\`${field}\` is required.`, 'missing_field', field);
    return undefined;
  }
  const v = typeof raw === 'string' ? cleanString(raw, ID_MAX, '').trim() : '';
  if (!v || v !== raw) throw invalid(`\`${field}\` must be a non-empty id of at most ${ID_MAX} characters.`, 'bad_field', field);
  return v;
}

/** The tools an agent may be offered in this tenant: override ?? manifest ∪ baseline (ADR 0315). */
async function effectiveAllowlistOf(tenantId: string, agentId: string): Promise<Set<string> | null> {
  const identity = await resolveAgentIdentity(tenantId, agentId, { allowReverseScan: true });
  const manifest = await getAgentRegistry().resolve(identity.agentId, tenantId);
  if (!manifest) return null;
  const override = await resolveAgentToolAllowlistOverride(tenantId, manifest.agentId);
  return new Set(effectiveToolAllowlist(manifest.toolAllowlist, override));
}

export async function getAgentBinding(tenantId: string, orgId: string, bindingId: string): Promise<ClientAgentBinding | null> {
  const b = await bindings.get(`${tenantId}::${orgId}::${bindingId}`);
  return b && b.tenantId === tenantId && b.orgId === orgId ? b : null;
}

/** Every binding of one client: a bounded prefix read of that client's slice. */
export async function listAgentBindings(tenantId: string, orgId: string): Promise<ClientAgentBinding[]> {
  return (await bindings.listByPrefix(`${tenantId}::${orgId}::`))
    .filter((b) => b.tenantId === tenantId && b.orgId === orgId)
    .sort((a, b) => a.pinnedAgentId.localeCompare(b.pinnedAgentId) || (a.workflowId ?? '').localeCompare(b.workflowId ?? '') || (a.nodeId ?? '').localeCompare(b.nodeId ?? ''));
}

/** Whether `raw.model` pins a stored key (the route asks for BYOK-manage then). */
export function pinsStoredKey(raw: unknown): boolean {
  const ref = raw && typeof raw === 'object' ? (raw as { model?: { credentialRef?: unknown } }).model?.credentialRef : undefined;
  return typeof ref === 'string' && ref.length > 0 && !isManagedRef(ref);
}

/**
 * Create or replace the binding for one scope. Validated closed-world before
 * anything is written; a concurrent writer to the same scope loses with 409.
 */
export async function upsertAgentBinding(input: {
  tenantId: string;
  orgId: string;
  body: unknown;
  updatedBy: string;
}): Promise<ClientAgentBinding> {
  const { tenantId, orgId } = input;
  if (!(await getClient(tenantId, orgId))) throw new OpenwopError('not_found', 'Client not found.', 404, { orgId });
  const body = (input.body && typeof input.body === 'object' ? input.body : {}) as Record<string, unknown>;
  const pinnedAgentId = idField(body.pinnedAgentId, 'pinnedAgentId', true)!;
  const agentId = idField(body.agentId, 'agentId', true)!;
  const workflowId = idField(body.workflowId, 'workflowId', false);
  const nodeId = idField(body.nodeId, 'nodeId', false);
  if (nodeId && !workflowId) throw invalid('A node binding also names its `workflowId`.', 'node_without_workflow', 'workflowId');

  const pinnedTools = await effectiveAllowlistOf(tenantId, pinnedAgentId);
  if (!pinnedTools) throw invalid(`The pinned agent '${pinnedAgentId}' is not installed in this workspace.`, 'pinned_agent_unknown', 'pinnedAgentId');
  const replacementTools = await effectiveAllowlistOf(tenantId, agentId);
  if (!replacementTools) throw invalid(`The agent '${agentId}' is not installed in this workspace.`, 'agent_unknown', 'agentId');
  const identity = await resolveAgentIdentity(tenantId, agentId, { allowReverseScan: true });
  if (identity.entry && !identity.entry.enabled) throw invalid(`The agent '${agentId}' is paused.`, 'agent_paused', 'agentId');
  const missing = [...pinnedTools].filter((t) => !replacementTools.has(t)).sort();
  if (missing.length > 0) {
    throw new OpenwopError('validation_error', `The agent '${agentId}' cannot use every tool the pinned agent can.`, 422, {
      reason: 'agent_binding_invalid', detail: 'tools_not_covered', field: 'agentId', missingTools: missing,
    });
  }

  let model: ClientAgentBinding['model'];
  if (body.model !== undefined && body.model !== null) {
    const m = (typeof body.model === 'object' ? body.model : {}) as Record<string, unknown>;
    if (typeof m.provider !== 'string' || !listSelectableProviderIds().includes(m.provider)) {
      throw invalid(`model.provider must be one of: ${listSelectableProviderIds().join(', ')}.`, 'bad_provider', 'model.provider');
    }
    if (typeof m.model !== 'string' || !m.model.trim() || m.model.length > MODEL_MAX) {
      throw invalid(`model.model must be a non-empty string of at most ${MODEL_MAX} characters.`, 'bad_model', 'model.model');
    }
    let credentialRef: string | undefined;
    if (m.credentialRef !== undefined && m.credentialRef !== null && m.credentialRef !== '') {
      if (typeof m.credentialRef !== 'string' || !REF_PATTERN.test(m.credentialRef)) {
        throw invalid('model.credentialRef must match [a-zA-Z0-9_.-:]{1,128}.', 'bad_credential_ref', 'model.credentialRef');
      }
      // The chatByokConfig IDOR rule: the ref must be this tenant's own stored,
      // resolvable secret. Managed sentinels name no stored row.
      if (!isManagedRef(m.credentialRef)) {
        const scope = { tenantId };
        if (!(await listSecretRefs(scope)).includes(m.credentialRef) || !(await resolveSecret(m.credentialRef, scope))) {
          throw invalid('model.credentialRef is not a usable stored key of this workspace.', 'unknown_credential_ref', 'model.credentialRef');
        }
      }
      credentialRef = m.credentialRef;
    }
    model = { provider: m.provider, model: m.model.trim(), ...(credentialRef ? { credentialRef } : {}) };
  }

  const bindingId = bindingIdOf(pinnedAgentId, workflowId, nodeId);
  const current = await getAgentBinding(tenantId, orgId, bindingId);
  const next: ClientAgentBinding = {
    tenantId, orgId, bindingId, pinnedAgentId, agentId,
    ...(workflowId ? { workflowId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(model ? { model } : {}),
    updatedAt: nowIso(),
    updatedBy: input.updatedBy,
  };
  if (!(await bindings.compareAndSwap(current, next))) {
    throw new OpenwopError('conflict', 'This binding changed while you were editing it. Reload and try again.', 409, { reason: 'agent_binding_changed' });
  }
  return next;
}

export async function deleteAgentBinding(tenantId: string, orgId: string, bindingId: string): Promise<boolean> {
  if (!(await getAgentBinding(tenantId, orgId, bindingId))) return false;
  return bindings.delete(`${tenantId}::${orgId}::${bindingId}`);
}

/** Remove every binding of one client (the client record is going away). */
export async function deleteClientAgentBindings(tenantId: string, orgId: string): Promise<number> {
  let n = 0;
  for (const b of await listAgentBindings(tenantId, orgId)) {
    if (await bindings.delete(`${tenantId}::${orgId}::${b.bindingId}`)) n++;
  }
  return n;
}

/** ADR 0464 — the binding is the client's configuration and stays; only the person goes. */
export async function eraseAgentBindingEditors(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const b of await bindings.listForTenantIndexed(tenantId)) {
    if (b.tenantId !== tenantId || !forms.has(b.updatedBy)) continue;
    if (await bindings.compareAndSwap(b, { ...b, updatedBy: tombstone })) n++;
  }
  return n;
}

// ADR 0499 — a binding can name a stored key, so deleting that key must SEE it
// (the BYOK delete answers 409 while a binding points at it).
registerCredentialRefConsumer({
  id: 'campaign-ops:agent-binding',
  async describe(tenantId, ref) {
    return (await bindings.listForTenantIndexed(tenantId))
      .filter((b) => b.tenantId === tenantId && b.model?.credentialRef === ref)
      .map((b) => `campaign agent binding (client ${b.orgId}, ${b.pinnedAgentId} → ${b.agentId})`);
  },
});
