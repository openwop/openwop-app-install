/**
 * MCP server registry — declarative scan of registered workflows for
 * `core.openwop.mcp.expose-{tool,resource,prompt}` and
 * `core.openwop.mcp.handle-{sampling,elicitation}` nodes.
 *
 * The RFC 0020 §A point 2 explicit phrase "host's equivalent declarative
 * shape" sanctions this approach: rather than runtime-registering via a
 * `ctx.mcp.expose(...)` call (which requires running the workflow once),
 * the registry scans each workflow definition at lookup time and extracts
 * the manifest from the node config. The conformance suite can register a
 * workflow via `POST /v1/host/openwop-app/workflows` and immediately have it
 * advertised in `tools/list`.
 *
 * Tenant scoping (ADR 0087 — what the gate covers, and what it does not):
 * the underlying `workflowsRegistry` is process-global by design (a real host
 * would persist per-tenant in storage). The RAW enumerators below (`listTools`,
 * `listResources`, `listPrompts`, `find*ByName/Uri`) are UNFILTERED — they walk
 * every registered workflow. They are NOT what reaches the MCP wire for gated
 * tools: the ADR 0087 gate `listToolsForPrincipal` / `isToolAllowed` (below)
 * filters every gated tool (one carrying `mcpRequiresAuth`/`mcpFeatureToggle`,
 * e.g. the notebook tools) against the caller — anonymous/`['*']` principals are
 * denied (`isAnonymousPrincipal`) and a toggle-gated tool requires that toggle
 * enabled for `principal.tenants[0]`. Both `tools/list` and `/v1/tools` go
 * through that one projection, so a gated tool cannot leak across tenants.
 * RESIDUAL (stated, not hidden): (1) UNGATED conformance sample tools (no
 * metadata hints) remain visible to anyone — intentional, they carry no tenant
 * data; (2) the gate keys off `principal.tenants[0]` only, so a multi-tenant
 * principal is pinned to its first tenant (fail-closed, see the MCP-5 test);
 * (3) a real multi-tenant host promoting this beyond the single shared workflow
 * space MUST also tenant-scope `workflowsRegistry` itself so the RAW enumerators
 * can't be reached out-of-band.
 *
 * @see RFCS/0020-host-mcp-server-composition.md §A points 1-3
 * @see packs/core.openwop.mcp/schemas/expose-tool.config.json
 */

import { listRegisteredWorkflows } from './workflowsRegistry.js';
import { listChainBackedWorkflows } from './chainBackedWorkflows.js';
import { resolveOne } from './featureToggles/service.js';
import { resolveEffectiveAccess, resolveSubjectScopesUnion, type Scope } from './accessControlService.js';
import { credentialAuthority, keyDeclarationPermits, tenantOwnerScopes } from './protocolAuthorization.js';
import type { WorkflowDefinition } from '../executor/types.js';
import type { Principal } from '../types.js';

/** Every workflow definition the host knows — the in-memory builder registry
 *  (conformance-registered) PLUS the hard-coded builtin catalog (feature
 *  `builtinWorkflows`, e.g. the ADR 0087 `notebooks.mcp.*` tools). Deduped by
 *  workflowId (builder wins). Without the builtin half, feature-shipped expose-tool
 *  workflows would never appear in `tools/list` / `/v1/tools`. */
function allWorkflowDefs(): WorkflowDefinition[] {
  const byId = new Map<string, WorkflowDefinition>();
  for (const def of listChainBackedWorkflows()) byId.set(def.workflowId, def); // ADR 0472 P4 — MCP projections
  for (const def of listRegisteredWorkflows()) byId.set(def.workflowId, def);
  return Array.from(byId.values());
}

export type ExposeKind = 'tool' | 'resource' | 'resource-template' | 'prompt';

export interface ExposedToolManifest {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  workflowId: string;
  /** ADR 0087 gate (from the workflow `metadata`, NOT the schema-locked expose-tool
   *  config): when set, the tool is listed/callable ONLY for a caller whose
   *  `<mcpFeatureToggle>` is enabled. */
  mcpFeatureToggle?: string;
  /** ADR 0087 gate: when true, the tool is denied to an anonymous principal. */
  mcpRequiresAuth?: boolean;
  /** RFC 0078 ToolDescriptor hints (from the workflow metadata) for the `/v1/tools`
   *  projection — the tool's data-effect tier + approval posture. */
  mcpSafetyTier?: string;
  mcpApproval?: string;
}

export interface ExposedResourceManifest {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  workflowId: string;
}

export interface ExposedPromptManifest {
  name: string;
  description?: string;
  arguments?: ReadonlyArray<{ name: string; description?: string; required?: boolean }>;
  workflowId: string;
}

export interface HandlerWorkflow {
  workflowId: string;
}

const TYPE_EXPOSE_TOOL = 'core.openwop.mcp.expose-tool';
const TYPE_EXPOSE_RESOURCE = 'core.openwop.mcp.expose-resource';
const TYPE_EXPOSE_RESOURCE_TEMPLATE = 'core.openwop.mcp.expose-resource-template';
const TYPE_EXPOSE_PROMPT = 'core.openwop.mcp.expose-prompt';
const TYPE_HANDLE_SAMPLING = 'core.openwop.mcp.handle-sampling';
const TYPE_HANDLE_ELICITATION = 'core.openwop.mcp.handle-elicitation';

function findNodes(def: WorkflowDefinition, typeId: string): Array<{ config?: Record<string, unknown> }> {
  return def.nodes.filter((n) => n.typeId === typeId);
}

/** Build the tool manifest for one `expose-tool` node (with its workflow's ADR
 *  0087 gate hints), or null if the node has no `name`. Shared by `listTools`
 *  (map-all) and `findToolByName` (early-return) so the two can't drift. */
function toolManifestFromNode(def: WorkflowDefinition, node: { config?: Record<string, unknown> }): ExposedToolManifest | null {
  const cfg = node.config ?? {};
  const name = typeof cfg.name === 'string' ? cfg.name : null;
  if (!name) return null;
  const description = typeof cfg.description === 'string' ? cfg.description : undefined;
  const inputSchema =
    cfg.inputSchema && typeof cfg.inputSchema === 'object'
      ? (cfg.inputSchema as Record<string, unknown>)
      : { type: 'object', additionalProperties: true };
  const entry: ExposedToolManifest = { name, inputSchema, workflowId: def.workflowId };
  if (description !== undefined) entry.description = description;
  // ADR 0087 — surface the gate hints from the workflow metadata (a tool may
  // require auth and/or a feature toggle before it is listed/called).
  const meta = (def.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.mcpFeatureToggle === 'string') entry.mcpFeatureToggle = meta.mcpFeatureToggle;
  if (meta.mcpRequiresAuth === true) entry.mcpRequiresAuth = true;
  if (typeof meta.mcpSafetyTier === 'string') entry.mcpSafetyTier = meta.mcpSafetyTier;
  if (typeof meta.mcpApproval === 'string') entry.mcpApproval = meta.mcpApproval;
  return entry;
}

export function listTools(): ExposedToolManifest[] {
  const out: ExposedToolManifest[] = [];
  for (const def of allWorkflowDefs()) {
    for (const node of findNodes(def, TYPE_EXPOSE_TOOL)) {
      const entry = toolManifestFromNode(def, node);
      if (entry) out.push(entry);
    }
  }
  return out;
}

export function findToolByName(name: string): ExposedToolManifest | null {
  // MCP-3 — early-return on the first match instead of materializing every tool.
  for (const def of allWorkflowDefs()) {
    for (const node of findNodes(def, TYPE_EXPOSE_TOOL)) {
      const entry = toolManifestFromNode(def, node);
      if (entry?.name === name) return entry;
    }
  }
  return null;
}

/**
 * ADR 0087 — is `principal` an anonymous/unscoped caller? The MCP mount's synthetic
 * `mcp-anonymous` fallback (conformance bypass) and any wildcard/empty-tenant
 * principal count as anonymous: gated tools MUST NOT be reachable by them (fail-closed).
 */
export function isAnonymousPrincipal(principal: Principal | undefined): boolean {
  if (!principal || principal.principalId === 'mcp-anonymous') return true;
  const tenants = principal.tenants ?? [];
  if (tenants.length === 0) return true;
  if (tenants.includes('*')) return true;
  if (!tenants[0] || tenants[0] === '*') return true;
  return false;
}

/**
 * ADR 0601 — THE RULE, written once: the RBAC scope a tool's RFC 0078 descriptor
 * ADVERTISES, and the scope `isToolAllowed` ENFORCES. Both call this one function,
 * so an advertised requirement cannot drift away from an enforced one.
 *
 * Before ADR 0601 the two halves lived apart: `routes/toolCatalog.ts` derived
 * `auth.scopes` from `mcpSafetyTier` and emitted `workspace:write` for the write
 * tools, while `isToolAllowed` checked only "non-anonymous" + the feature toggle.
 * A `workspace:read` member 403'd by every HTTP sibling could point an MCP client
 * at the same host and write. The descriptor was a claim the host did not honour.
 *
 * `null` means the tool claims NO scope and none is checked — the ungated
 * conformance sample tools (no `mcpRequiresAuth`, no `mcpFeatureToggle`). That
 * branch is honest by construction rather than by comment: the catalog now emits
 * `scopes: []` for exactly the tools this returns `null` for, so there is no tool
 * anywhere that advertises a scope nothing enforces.
 */
export function requiredScopeForTool(manifest: ExposedToolManifest): 'workspace:write' | 'workspace:read' | null {
  if (!manifest.mcpRequiresAuth && !manifest.mcpFeatureToggle) return null;
  return manifest.mcpSafetyTier === 'write' ? 'workspace:write' : 'workspace:read';
}

/**
 * ADR 0601 R1 (corrected) — the ONE answer to "what may this MCP caller do in
 * this tenant", for EVERY credential lane `middleware/auth.ts` can mint.
 *
 * The first cut of this gate asked `resolveEffectiveAccess(tenantId, { subject:
 * principal.principalId })` and was wrong twice.
 *
 *  1. **It could never match for a credential principal.** `principalId` is an
 *     identity, and only the cookie/OIDC lanes mint one that is also an RBAC
 *     SUBJECT. The API-key lanes mint `bearer:<first 8 chars>` / `apikey:<keyId>`
 *     — strings no member row is ever keyed on, and the first of which changes on
 *     rotation. MEASURED on this branch, demo mode OFF: 17 gated tools before the
 *     gate, **0 after**, for env-key, `owk_` key, anonymous session AND the
 *     conformance seam — four lanes, not the two first reported. Telling an
 *     operator to seed a member row named after eight characters of their secret
 *     is not an exit.
 *  2. **It was non-deterministic.** With no `orgId`, `resolveEffectiveAccess`
 *     takes the FIRST matching member row, so a subject who is `viewer` in org-A
 *     and `editor` in org-B resolves to whichever the store iterates first — an
 *     answer that can flap across a restart. `resolveSubjectScopesUnion`'s own
 *     docblock names this exact shape ("the org-scoped, first-match … is the
 *     wrong tool") for exactly this kind of non-org-scoped surface.
 *
 * So authority is resolved from PROVENANCE (`Principal.auth`, stamped where the
 * credential was verified) rather than guessed from the id string:
 *
 *  - `api-key` — an `owk_` key is a **delegation**. Its authority is its
 *    ISSUER's (`ApiKeyRecord.createdBy`, a real subject), narrowed by the key's
 *    own declared scopes when it declares any (ADR 0270: "a key can't exceed its
 *    scopes"). This is what keeps the restoration from becoming an escalation:
 *    `POST /developer-keys` is gated on `requirePrincipal` alone, so ANY
 *    authenticated member — including a `viewer` — can mint a key. Had an
 *    unscoped key been granted the tenant's own authority (the tempting reading
 *    of "a key carries its own authority"), that viewer would have written over
 *    MCP through a key they issued themselves, re-opening the very escalation
 *    ADR 0601 closed, through a side door.
 *  - `env-key` — configured in the host's own environment, so whoever set it is
 *    the deployment operator, not a tenant member. It acts as the tenant's own
 *    principal in the tenant ADR 0561 pinned it to. A member cannot mint one, so
 *    there is no escalation path. (A `*`-scoped env key is still denied every
 *    gated tool by `isAnonymousPrincipal` — pre-existing ADR 0087 behaviour,
 *    deliberately not widened here.)
 *  - `subject` / `anon` / `test-seam` / unstamped — resolved as a subject, below.
 *
 * Subject resolution is the DETERMINISTIC tenant-wide union, and only falls back
 * to `resolveEffectiveAccess` when the union found no membership at all. That
 * fallback is not a re-introduction of the first-match ambiguity — it is only
 * reachable when there are ZERO rows to be ambiguous between — and it exists so
 * the "no member row" rules (the tenant-owner principal, and the demo
 * single-principal exception at `accessControlService.ts:1271`) keep living in
 * ONE place. Copying that exception here would have been a second implementation
 * of a security rule; omitting it would have silently taken every anonymous
 * session on the demo deploy from working tools to none.
 */
async function resolveMcpAuthority(principal: Principal): Promise<readonly Scope[]> {
  const tenantId = principal.tenants[0]!;
  // The provenance classification is shared with the content ops (ADR 0748
  // correction): ONE reading of where a credential's authority comes from.
  const authority = credentialAuthority(principal, principal.principalId);
  if (authority.source === 'tenant-owner') return tenantOwnerScopes(tenantId);
  const subject = authority.subject ?? principal.principalId;
  const union = await resolveSubjectScopesUnion(tenantId, subject);
  const scopes = union.basis === 'member' ? union.scopes : (await resolveEffectiveAccess(tenantId, { subject })).scopes;
  // An undeclared scope list means "undeclared", not "none" — every key issued
  // before ADR 0601 carries `[]`. A key that DOES declare scopes is narrowed to
  // them: strictly tighter, never looser. ADR 0755 D2: the ONE reading shared
  // with the protocol lane — `'*'` is undeclared here too.
  const declared = authority.declaredScopes;
  return declared ? scopes.filter((s) => keyDeclarationPermits(declared, s)) : scopes;
}

/**
 * ADR 0087 gate (+ ADR 0601 scope enforcement) — may `principal` see/call this
 * tool? An ungated tool (no metadata hints — the conformance sample tools) is
 * allowed for anyone, preserving the existing reference behavior. A gated tool
 * (e.g. the notebook tools) requires a non-anonymous caller, the
 * `mcpFeatureToggle` enabled for the caller's tenant when set, AND the RBAC scope
 * its own descriptor advertises. Fail-closed at every step.
 *
 * `authority` is the caller's resolved scope set. It is a PARAMETER rather than a
 * lookup so a `tools/list` over N tools resolves it ONCE: it used to be resolved
 * per tool, and `resolveEffectiveAccess` full-scans members + groups + customRoles
 * (`members.list()` is the cross-tenant scan the tenant index at
 * `accessControlService.ts:374` exists to avoid), so a single list call did ~57
 * full collection scans — the `host_ext_kv` prefix-scan incident's exact shape.
 *
 * RESIDUAL, stated rather than hidden (ADR 0601 § Residuals, rewritten): the
 * scope is resolved TENANT-wide — the UNION across the caller's org memberships,
 * because a `tools/list` call names no org and there is no org to scope to. So
 * this closes "a `workspace:read` member writes over MCP" — the named escalation
 * — and does NOT close "a member with write in org A writes a notebook in org B".
 * The per-org check belongs at the SURFACE, where the resource names its org
 * (`resolveProjectAccess` already does exactly that for the notebook tools'
 * backing routes). Do not read this gate as more than it is.
 */
export async function isToolAllowedWith(
  manifest: ExposedToolManifest,
  principal: Principal | undefined,
  authority: () => Promise<readonly Scope[]>,
): Promise<boolean> {
  if (!manifest.mcpRequiresAuth && !manifest.mcpFeatureToggle) return true;
  if (isAnonymousPrincipal(principal)) return false;
  const tenantId = principal!.tenants[0]!;
  if (manifest.mcpFeatureToggle) {
    const assignment = await resolveOne(manifest.mcpFeatureToggle, { tenantId, userId: principal!.principalId });
    if (!assignment || !assignment.enabled) return false;
  }
  const required = requiredScopeForTool(manifest);
  if (required) {
    if (!(await authority()).includes(required)) return false;
  }
  return true;
}

/** A once-per-call memo of `resolveMcpAuthority`. Lazy on purpose: a caller whose
 *  tools are all ungated never pays for a resolution nothing will read. */
function authorityOnce(principal: Principal | undefined): () => Promise<readonly Scope[]> {
  let pending: Promise<readonly Scope[]> | undefined;
  return () => (pending ??= principal ? resolveMcpAuthority(principal) : Promise.resolve([]));
}

/** ADR 0087 — the single-tool gate (`tools/call`, `GET /v1/tools/{toolId}`). */
export async function isToolAllowed(manifest: ExposedToolManifest, principal: Principal | undefined): Promise<boolean> {
  return isToolAllowedWith(manifest, principal, authorityOnce(principal));
}

/** ADR 0087 — the tools `principal` is authorized to see (the gated projection used
 *  by both `tools/list` and the `/v1/tools` discovery endpoint). ADR 0601: ONE
 *  authority resolution for the whole list, not one per tool. */
export async function listToolsForPrincipal(principal: Principal | undefined): Promise<ExposedToolManifest[]> {
  const all = listTools();
  const authority = authorityOnce(principal);
  const allowed = await Promise.all(all.map((t) => isToolAllowedWith(t, principal, authority)));
  return all.filter((_, i) => allowed[i]);
}

export function listResources(): ExposedResourceManifest[] {
  const out: ExposedResourceManifest[] = [];
  for (const def of allWorkflowDefs()) {
    for (const node of findNodes(def, TYPE_EXPOSE_RESOURCE)) {
      const cfg = node.config ?? {};
      const uri = typeof cfg.uri === 'string' ? cfg.uri : null;
      if (!uri) continue;
      const entry: ExposedResourceManifest = { uri, workflowId: def.workflowId };
      if (typeof cfg.name === 'string') entry.name = cfg.name;
      if (typeof cfg.description === 'string') entry.description = cfg.description;
      if (typeof cfg.mimeType === 'string') entry.mimeType = cfg.mimeType;
      out.push(entry);
    }
  }
  return out;
}

export function listResourceTemplates(): ExposedResourceManifest[] {
  const out: ExposedResourceManifest[] = [];
  for (const def of allWorkflowDefs()) {
    for (const node of findNodes(def, TYPE_EXPOSE_RESOURCE_TEMPLATE)) {
      const cfg = node.config ?? {};
      const uri = typeof cfg.uriTemplate === 'string' ? cfg.uriTemplate : null;
      if (!uri) continue;
      const entry: ExposedResourceManifest = { uri, workflowId: def.workflowId };
      if (typeof cfg.name === 'string') entry.name = cfg.name;
      if (typeof cfg.description === 'string') entry.description = cfg.description;
      if (typeof cfg.mimeType === 'string') entry.mimeType = cfg.mimeType;
      out.push(entry);
    }
  }
  return out;
}

export function findResourceByUri(uri: string): ExposedResourceManifest | null {
  return listResources().find((r) => r.uri === uri) ?? null;
}

export function listPrompts(): ExposedPromptManifest[] {
  const out: ExposedPromptManifest[] = [];
  for (const def of allWorkflowDefs()) {
    for (const node of findNodes(def, TYPE_EXPOSE_PROMPT)) {
      const cfg = node.config ?? {};
      const name = typeof cfg.name === 'string' ? cfg.name : null;
      if (!name) continue;
      const entry: ExposedPromptManifest = { name, workflowId: def.workflowId };
      if (typeof cfg.description === 'string') entry.description = cfg.description;
      if (Array.isArray(cfg.arguments)) {
        entry.arguments = cfg.arguments.filter(
          (a): a is { name: string; description?: string; required?: boolean } =>
            typeof a === 'object' && a !== null && typeof (a as { name?: unknown }).name === 'string',
        );
      }
      out.push(entry);
    }
  }
  return out;
}

export function findPromptByName(name: string): ExposedPromptManifest | null {
  return listPrompts().find((p) => p.name === name) ?? null;
}

/** Find the first workflow that contains a handle-sampling node. */
export function findSamplingHandler(): HandlerWorkflow | null {
  for (const def of allWorkflowDefs()) {
    if (findNodes(def, TYPE_HANDLE_SAMPLING).length > 0) {
      return { workflowId: def.workflowId };
    }
  }
  return null;
}

/** Find the first workflow that contains a handle-elicitation node. */
export function findElicitationHandler(): HandlerWorkflow | null {
  for (const def of allWorkflowDefs()) {
    if (findNodes(def, TYPE_HANDLE_ELICITATION).length > 0) {
      return { workflowId: def.workflowId };
    }
  }
  return null;
}
