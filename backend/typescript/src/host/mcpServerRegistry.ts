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
 * Tenant scoping (ADR 0788 D1 — this REPLACES the ADR 0087 "residual 3"
 * paragraph that used to sit here). The registry used to walk the process-global
 * builder registry, unfiltered, and trust each workflow's OWN metadata as its
 * gate. So any signed-in user could register an ungated `expose-tool` workflow
 * in their personal tenant and have it listed — name and description — in every
 * other tenant's MCP client, running under the CALLER's tenant (`MCPWF-1`).
 * The docblock named that as a residual "a real multi-tenant host MUST" close;
 * this host was that host, with the mount enabled in production.
 *
 * Now every enumeration is made FOR an `McpCaller` (`host/mcpCaller.ts`) and
 * walks exactly two sources:
 *  - `host` — the host-shipped chain-backed projections, whose gate metadata is
 *    merged from reviewed source at boot. Visible in every tenant, gated by that
 *    metadata (ADR 0087 / 0601).
 *  - `workspace` — the caller tenant's OWN workflows, read from the durable
 *    ownership index and resolved through the launch resolution a call runs.
 *    Included only when the caller may launch them (`workspaceLaunch`); author
 *    metadata can only narrow them (a `mcpFeatureToggle`), never lower the gate.
 * The raw process-global registry is not read at all, which also closes the
 * instance-local list (`MCPWF-2`: that cache is never hydrated at boot).
 *
 * @see RFCS/0020-host-mcp-server-composition.md §A points 1-3
 * @see packs/core.openwop.mcp/schemas/expose-tool.config.json
 */

import { listChainBackedWorkflows } from './chainBackedWorkflows.js';
import { resolveOne } from './featureToggles/service.js';
import type { Scope } from './accessControlService.js';
import { credentialScopesIn } from './protocolAuthorization.js';
import type { WorkflowDefinition } from '../executor/types.js';
import type { Principal } from '../types.js';
import type { McpCaller } from './mcpCaller.js';
import { listOwned, PUBLIC_WORKFLOW_ID } from './workflowOwnership.js';
import { catalogVisible } from './workflowLifecycle.js';
import { exposureKey, getDisabledEntries } from './mcpExposure.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.mcpServerRegistry');

/** The HOST projections only (ADR 0788 D1). Tenant workflows are reached
 *  through {@link exposureFor}, never through a global walk. */
function hostWorkflowDefs(): WorkflowDefinition[] {
  return [...listChainBackedWorkflows()];
}

export type ExposeKind = 'tool' | 'resource' | 'resource-template' | 'prompt';

/** ADR 0788 D1 — where an exposed entry comes from. `host`: a host-shipped
 *  projection whose metadata is reviewed source. `workspace`: a workflow the
 *  caller's tenant owns, whose metadata is author-supplied and therefore can
 *  only narrow its gate. */
export type McpEntrySource = 'host' | 'workspace';

export interface ExposedToolManifest {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  workflowId: string;
  source: McpEntrySource;
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
  source: McpEntrySource;
}

export interface ExposedPromptManifest {
  name: string;
  description?: string;
  arguments?: ReadonlyArray<{ name: string; description?: string; required?: boolean }>;
  workflowId: string;
  source: McpEntrySource;
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
function toolManifestFromNode(def: WorkflowDefinition, node: { config?: Record<string, unknown> }, source: McpEntrySource = 'host'): ExposedToolManifest | null {
  const cfg = node.config ?? {};
  const name = typeof cfg.name === 'string' ? cfg.name : null;
  if (!name) return null;
  const description = typeof cfg.description === 'string' ? cfg.description : undefined;
  const inputSchema =
    cfg.inputSchema && typeof cfg.inputSchema === 'object'
      ? (cfg.inputSchema as Record<string, unknown>)
      : { type: 'object', additionalProperties: true };
  const entry: ExposedToolManifest = { name, inputSchema, workflowId: def.workflowId, source };
  if (description !== undefined) entry.description = description;
  // ADR 0087 — surface the gate hints from the workflow metadata (a tool may
  // require auth and/or a feature toggle before it is listed/called).
  const meta = (def.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.mcpFeatureToggle === 'string') entry.mcpFeatureToggle = meta.mcpFeatureToggle;
  if (typeof meta.mcpApproval === 'string') entry.mcpApproval = meta.mcpApproval;
  if (source === 'workspace') {
    // ADR 0788 D1 — author metadata can only NARROW a workspace tool. It always
    // requires an authenticated caller and is always a write-tier launch, whatever
    // the author declared: `mcpSafetyTier: 'read'` on a graph that writes would
    // otherwise hand a viewer a write.
    entry.mcpRequiresAuth = true;
    entry.mcpSafetyTier = 'write';
    return entry;
  }
  if (meta.mcpRequiresAuth === true) entry.mcpRequiresAuth = true;
  if (typeof meta.mcpSafetyTier === 'string') entry.mcpSafetyTier = meta.mcpSafetyTier;
  return entry;
}

/** The HOST projections' tools, ungated — a raw enumerator for boot checks and
 *  tests. What a caller may see is {@link listToolsForCaller}. */
export function listTools(): ExposedToolManifest[] {
  const out: ExposedToolManifest[] = [];
  for (const def of hostWorkflowDefs()) {
    for (const node of findNodes(def, TYPE_EXPOSE_TOOL)) {
      const entry = toolManifestFromNode(def, node);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** Raw HOST-projection lookup by name (tests, boot checks). Callers resolve
 *  through {@link exposureFor}. */
export function findToolByName(name: string): ExposedToolManifest | null {
  // MCP-3 — early-return on the first match instead of materializing every tool.
  for (const def of hostWorkflowDefs()) {
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
  // The provenance classification AND its scope resolution are shared with the
  // content ops and the kanban write gate (ADR 0748 correction, ADR 0774 D5):
  // ONE reading of where a credential's authority comes from.
  return credentialScopesIn(principal, principal.tenants[0]!, principal.principalId);
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
  caller?: Pick<McpCaller, 'tenantId' | 'workspaceLaunch'>,
): Promise<boolean> {
  if (manifest.source === 'workspace') {
    // ADR 0788 D1 — a workspace tool launches an arbitrary tenant workflow, so it
    // takes the AUTHORING predicate (resolved once per request as
    // `workspaceLaunch`), not the principal-id scope union above: that union lacks
    // the personal-owner and personal-key short-circuits, and would hide a
    // personal owner's own tools (architect B4). A wildcard operator passes it,
    // exactly as it may author there. A toggle the author named still narrows.
    if (!caller?.workspaceLaunch) return false;
    if (manifest.mcpFeatureToggle) {
      const assignment = await resolveOne(manifest.mcpFeatureToggle, { tenantId: caller.tenantId, ...(principal ? { userId: principal.principalId } : {}) });
      if (!assignment || !assignment.enabled) return false;
    }
    return true;
  }
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

// ─────────────────────────────────────────────────────────────────
// ADR 0788 D1 — the caller-scoped exposure: the ONE enumeration every MCP lane
// reads (tools/list + tools/call, resources, templates, prompts, the legacy
// handler bridges, and /v1/tools). List and call share it, so a name can never
// resolve to a different entry than the list showed.
// ─────────────────────────────────────────────────────────────────

export interface ExposedHandler {
  workflowId: string;
  source: McpEntrySource;
}

export interface McpExposure {
  /** Every tool this caller may see AND call, host first, deterministic. */
  tools: ExposedToolManifest[];
  /** ADR 0788 D5 — tools the gate admits but a workspace admin switched off.
   *  Never on the wire; the exposure admin view lists them as `disabled`. */
  suppressed: ExposedToolManifest[];
  resources: ExposedResourceManifest[];
  resourceTemplates: ExposedResourceManifest[];
  prompts: ExposedPromptManifest[];
  samplingHandler: ExposedHandler | null;
  elicitationHandler: ExposedHandler | null;
  /** The launch-resolved definition of each WORKSPACE entry, by workflowId, so a
   *  call runs exactly the graph the list was derived from (architect H1). */
  workspaceDefinitions: ReadonlyMap<string, { definition: WorkflowDefinition; launchResolved: 'published' | 'head' }>;
}

const MCP_NODE_TYPES = new Set([
  TYPE_EXPOSE_TOOL,
  TYPE_EXPOSE_RESOURCE,
  TYPE_EXPOSE_RESOURCE_TEMPLATE,
  TYPE_EXPOSE_PROMPT,
  TYPE_HANDLE_SAMPLING,
  TYPE_HANDLE_ELICITATION,
]);

function hasMcpNode(def: WorkflowDefinition): boolean {
  return def.nodes.some((n) => MCP_NODE_TYPES.has(n.typeId));
}

function resourceFromNode(def: WorkflowDefinition, cfg: Record<string, unknown>, uriKey: 'uri' | 'uriTemplate', source: McpEntrySource): ExposedResourceManifest | null {
  const uri = typeof cfg[uriKey] === 'string' ? (cfg[uriKey] as string) : null;
  if (!uri) return null;
  const entry: ExposedResourceManifest = { uri, workflowId: def.workflowId, source };
  if (typeof cfg.name === 'string') entry.name = cfg.name;
  if (typeof cfg.description === 'string') entry.description = cfg.description;
  if (typeof cfg.mimeType === 'string') entry.mimeType = cfg.mimeType;
  return entry;
}

function promptFromNode(def: WorkflowDefinition, cfg: Record<string, unknown>, source: McpEntrySource): ExposedPromptManifest | null {
  const name = typeof cfg.name === 'string' ? cfg.name : null;
  if (!name) return null;
  const entry: ExposedPromptManifest = { name, workflowId: def.workflowId, source };
  if (typeof cfg.description === 'string') entry.description = cfg.description;
  if (Array.isArray(cfg.arguments)) {
    entry.arguments = cfg.arguments.filter(
      (a): a is { name: string; description?: string; required?: boolean } =>
        typeof a === 'object' && a !== null && typeof (a as { name?: unknown }).name === 'string',
    );
  }
  return entry;
}

/** The caller tenant's own MCP-bearing workflows, newest-owned first, each
 *  resolved the way a launch resolves it. Empty unless the caller may launch
 *  them. Transient and archived rows are skipped from the ownership row alone,
 *  before any definition read (architect M2). */
async function workspaceDefinitions(caller: McpCaller): Promise<Array<{ definition: WorkflowDefinition; launchResolved: 'published' | 'head' }>> {
  if (!caller.workspaceLaunch) return [];
  let rows;
  try {
    rows = await listOwned(caller.tenantId);
  } catch (err) {
    // No ownership store (an embedding without host-ext persistence) — there is
    // nothing tenant-owned to expose. Fail closed: host projections only.
    log.warn('mcp_workspace_enumeration_failed', { tenantId: caller.tenantId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  const out: Array<{ definition: WorkflowDefinition; launchResolved: 'published' | 'head' }> = [];
  for (const row of rows) {
    if (row.transient || row.archivedAt) continue;
    // grade-code MCPCD-4 — a PUBLIC-namespace id (`wf.seed.*`, `tmpl.*`,
    // `openwop-app.*`) is ONE definition every tenant that owns it shares, and any
    // owner can overwrite it. Exposing it as "this workspace's own tool" would let
    // an editor in one tenant put a graph into every other tenant's MCP client —
    // MCPWF-1 through a different door. A workspace exposes only its OWN ids.
    if (PUBLIC_WORKFLOW_ID.test(row.workflowId)) continue;
    const resolved = await caller.resolveLaunch(row.workflowId);
    if (!resolved || !catalogVisible(resolved.definition) || !hasMcpNode(resolved.definition)) continue;
    out.push({ definition: resolved.definition, launchResolved: resolved.launchResolved });
  }
  return out;
}

async function computeExposure(caller: McpCaller): Promise<McpExposure> {
  const principal = caller.principal;
  const authority = authorityOnce(principal);
  const tools: ExposedToolManifest[] = [];
  const suppressed: ExposedToolManifest[] = [];
  // Fails CLOSED (grade-code MCPCD-8): a storage error here rejects the whole
  // request rather than reading as "nothing disabled", which would re-enable every
  // tool an admin switched off for the length of a database blip.
  const disabled = await getDisabledEntries(caller.tenantId);
  // grade-code MCPCD-6 — a host projection's name is reserved whether or not
  // THIS caller passes its gate. Reserving only the names that passed let a
  // workspace tool take the name of a toggle-gated host tool, and silently start
  // resolving to a different workflow the day the toggle turned on.
  const hostToolNames = new Set(listTools().map((t) => t.name));
  const resources: ExposedResourceManifest[] = [];
  const resourceTemplates: ExposedResourceManifest[] = [];
  const prompts: ExposedPromptManifest[] = [];
  let samplingHandler: ExposedHandler | null = null;
  let elicitationHandler: ExposedHandler | null = null;
  const toolNames = new Set<string>();
  const resourceUris = new Set<string>();
  const templateUris = new Set<string>();
  const promptNames = new Set<string>();
  const defsById = new Map<string, { definition: WorkflowDefinition; launchResolved: 'published' | 'head' }>();

  const visit = async (def: WorkflowDefinition, source: McpEntrySource): Promise<void> => {
    // grade-code MCPCD-9 — a workspace author's `mcpFeatureToggle` narrows EVERY
    // entry the workflow exposes (resources, prompts, handlers), not only its
    // tools: each of them starts a run.
    if (source === 'workspace') {
      const toggle = (def.metadata as Record<string, unknown> | undefined)?.mcpFeatureToggle;
      if (typeof toggle === 'string') {
        const assignment = await resolveOne(toggle, { tenantId: caller.tenantId, ...(principal ? { userId: principal.principalId } : {}) });
        if (!assignment || !assignment.enabled) return;
      }
    }
    for (const node of def.nodes) {
      const cfg = node.config ?? {};
      switch (node.typeId) {
        case TYPE_EXPOSE_TOOL: {
          const entry = toolManifestFromNode(def, node, source);
          if (!entry) break;
          // Name precedence (ADR 0788 D1): a host projection's name is reserved;
          // within the workspace the newest-owned wins. Either way the list never
          // carries two entries with one name.
          if (toolNames.has(entry.name) || (source === 'workspace' && hostToolNames.has(entry.name))) {
            log.info('mcp_tool_name_shadowed', { toolName: entry.name, workflowId: def.workflowId, source });
            break;
          }
          if (!(await isToolAllowedWith(entry, principal, authority, caller))) break;
          toolNames.add(entry.name);
          // D5 — after the gate, so suppression can only narrow what it admits.
          if (disabled.has(exposureKey(entry.source, entry.workflowId, entry.name))) suppressed.push(entry);
          else tools.push(entry);
          break;
        }
        case TYPE_EXPOSE_RESOURCE: {
          const entry = resourceFromNode(def, cfg, 'uri', source);
          if (entry && !resourceUris.has(entry.uri)) { resourceUris.add(entry.uri); resources.push(entry); }
          break;
        }
        case TYPE_EXPOSE_RESOURCE_TEMPLATE: {
          const entry = resourceFromNode(def, cfg, 'uriTemplate', source);
          if (entry && !templateUris.has(entry.uri)) { templateUris.add(entry.uri); resourceTemplates.push(entry); }
          break;
        }
        case TYPE_EXPOSE_PROMPT: {
          const entry = promptFromNode(def, cfg, source);
          if (entry && !promptNames.has(entry.name)) { promptNames.add(entry.name); prompts.push(entry); }
          break;
        }
        case TYPE_HANDLE_SAMPLING:
          // Handlers are WORKSPACE-only: a host projection never carries one, and
          // "first workflow wins" across tenants is exactly the MCPWF-1 hole.
          if (source === 'workspace') samplingHandler ??= { workflowId: def.workflowId, source };
          break;
        case TYPE_HANDLE_ELICITATION:
          if (source === 'workspace') elicitationHandler ??= { workflowId: def.workflowId, source };
          break;
        default:
          break;
      }
    }
  };

  for (const def of hostWorkflowDefs()) await visit(def, 'host');
  // Resources, templates and prompts from the host carry no gate metadata today
  // (no host projection exposes one); they are listed as they always were.
  for (const resolved of await workspaceDefinitions(caller)) {
    defsById.set(resolved.definition.workflowId, resolved);
    await visit(resolved.definition, 'workspace');
  }
  return { tools, suppressed, resources, resourceTemplates, prompts, samplingHandler, elicitationHandler, workspaceDefinitions: defsById };
}

const exposureMemo = new WeakMap<McpCaller, Promise<McpExposure>>();

/** The caller-scoped exposure, computed at most once per `McpCaller` (one HTTP
 *  request): a `tools/call` that re-derives its tool pays one enumeration. */
export function exposureFor(caller: McpCaller): Promise<McpExposure> {
  let pending = exposureMemo.get(caller);
  if (!pending) {
    pending = computeExposure(caller);
    exposureMemo.set(caller, pending);
  }
  return pending;
}

/** ADR 0087 + 0788 — the tools this caller may see (tools/list, /v1/tools). */
export async function listToolsForCaller(caller: McpCaller): Promise<ExposedToolManifest[]> {
  return (await exposureFor(caller)).tools;
}

/** ADR 0788 — resolve a tool by name through the SAME enumeration the list used;
 *  `null` for unknown and unauthorized alike (no existence oracle). */
export async function findToolForCaller(caller: McpCaller, name: string): Promise<ExposedToolManifest | null> {
  return (await exposureFor(caller)).tools.find((t) => t.name === name) ?? null;
}

/** Host-projection-only authorization view, for tests and the legacy
 *  single-principal callers: the tools `principal` may see from the HOST source.
 *  Workspace tools need a request-resolved {@link McpCaller}. */
export async function listToolsForPrincipal(principal: Principal | undefined): Promise<ExposedToolManifest[]> {
  const all = listTools();
  const authority = authorityOnce(principal);
  const allowed = await Promise.all(all.map((t) => isToolAllowedWith(t, principal, authority)));
  return all.filter((_, i) => allowed[i]);
}
