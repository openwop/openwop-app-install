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
import { listBuiltinWorkflows } from './builtinWorkflows.js';
import { resolveOne } from './featureToggles/service.js';
import type { WorkflowDefinition } from '../executor/types.js';
import type { Principal } from '../types.js';

/** Every workflow definition the host knows — the in-memory builder registry
 *  (conformance-registered) PLUS the hard-coded builtin catalog (feature
 *  `builtinWorkflows`, e.g. the ADR 0087 `notebooks.mcp.*` tools). Deduped by
 *  workflowId (builder wins). Without the builtin half, feature-shipped expose-tool
 *  workflows would never appear in `tools/list` / `/v1/tools`. */
function allWorkflowDefs(): WorkflowDefinition[] {
  const byId = new Map<string, WorkflowDefinition>();
  for (const def of listBuiltinWorkflows()) byId.set(def.workflowId, def);
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
 * ADR 0087 gate — may `principal` see/call this tool? An ungated tool (no metadata
 * hints — the conformance sample tools) is allowed for anyone, preserving the
 * existing reference behavior. A gated tool (e.g. the notebook tools) requires a
 * non-anonymous caller AND, when `mcpFeatureToggle` is set, that toggle enabled for
 * the caller's tenant. Fail-closed.
 */
export async function isToolAllowed(manifest: ExposedToolManifest, principal: Principal | undefined): Promise<boolean> {
  if (!manifest.mcpRequiresAuth && !manifest.mcpFeatureToggle) return true;
  if (isAnonymousPrincipal(principal)) return false;
  if (manifest.mcpFeatureToggle) {
    const tenantId = principal!.tenants[0]!;
    const assignment = await resolveOne(manifest.mcpFeatureToggle, { tenantId, userId: principal!.principalId });
    if (!assignment || !assignment.enabled) return false;
  }
  return true;
}

/** ADR 0087 — the tools `principal` is authorized to see (the gated projection used
 *  by both `tools/list` and the `/v1/tools` discovery endpoint). */
export async function listToolsForPrincipal(principal: Principal | undefined): Promise<ExposedToolManifest[]> {
  const all = listTools();
  const allowed = await Promise.all(all.map((t) => isToolAllowed(t, principal)));
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
