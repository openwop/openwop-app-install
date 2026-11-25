/**
 * ADR 1099 D5/D6 — the tools a collaborator turn may call: `registerClientProjectTool`.
 *
 * A collaborator turn (`collaboratorTurn.ts`) offers the model ONLY the tools
 * registered here for the grant's resource kind, and only those whose action the
 * grant holds. Nothing else resolves in that lane: neither the ADR 0315 default-on
 * baseline nor any member tool, because the lane compiles and executes from this
 * registry alone.
 *
 * The scope is the grant's, never the model's: the host hands `run` the tenant, org,
 * resource id and grant id it read from the grant, and strips any scope key the model
 * put in the input. `checkGrantUse` runs again before every call (in the lane), so a
 * grant revoked mid-conversation refuses the next call.
 *
 * Two effects:
 *  - `read`: `run` returns what the model reads;
 *  - `propose` (P3, D6): `run` returns `{ proposals }`, and NOTHING is written. Each
 *    proposal is held as one `collab-proposal` approval; a member approves or rejects
 *    it, and only on approve does the host call the tool's `apply` with the grant's
 *    scope. One proposal per item (an answered question, a choice), grouped for
 *    display by `groupKey`; the same `idempotencyKey` on the same grant and tool is
 *    one approval, so rerunning an interview adds nothing.
 */
import type { GrantAction } from './externalCollaborators.js';
import type { AgentToolDef } from './agentDispatch.js';

/** What a client tool is told about the call. All of it comes from the grant. */
export interface ClientToolScope {
  tenantId: string;
  orgId: string;
  /** The grant's resource kind and id (e.g. `project` and the project id). */
  resourceKind: string;
  resourceId: string;
  grantId: string;
  collaboratorId: string;
  /** The grant's `audience` label (ADR 1099, decided 2026-11-23). Absent ⇒ the tool
   *  must answer with its least-privileged view. */
  audience?: string;
}

interface ClientToolBase {
  /** The tool id the model sees. Must start with `openwop:client.<kind>.` so the
   *  capability firewall classifies it (`toolCapabilityResolver.ts`). */
  id: string;
  /** The grant resource kind this tool serves (e.g. `project`). */
  kind: string;
  /** The feature that owns it (for the audit and for removal). */
  featureId: string;
  /** The grant action every call is checked against. */
  action: GrantAction;
  description: string;
  /** The model-facing input schema. Must not name a scope key (see SCOPE_KEYS). */
  inputSchema: Record<string, unknown>;
}

export interface ClientReadTool extends ClientToolBase {
  effect: 'read';
  /** The tool's work, on the grant's scope. Returns what the model reads. */
  run: (scope: ClientToolScope, input: Record<string, unknown>) => Promise<unknown>;
}

/** One item a collaborator proposes. Becomes one approval. */
export interface ClientProposal {
  /** Display grouping: the adopter's submission or session id. ≤ 200 chars. */
  groupKey: string;
  /** Same key, same grant, same tool ⇒ the same approval (a rerun adds nothing).
   *  E.g. `<submissionId>:<field>`. ≤ 200 chars. */
  idempotencyKey: string;
  /** What the member reviews, in a sentence. ≤ 500 chars. */
  summary: string;
  /** What `apply` receives on approve. JSON, ≤ 16 KB; scope keys are dropped. */
  payload: Record<string, unknown>;
}

export interface ClientProposeTool extends ClientToolBase {
  effect: 'propose';
  /** Build the proposals from the model's input. Must write NOTHING. */
  run: (scope: ClientToolScope, input: Record<string, unknown>) => Promise<{ proposals: ClientProposal[] }>;
  /** Called once, after a member approves. `scope` is rebuilt from the grant the
   *  proposal was made under. Should be idempotent on `ctx.approvalId`. Throwing
   *  reopens the approval (it never reads as approved when nothing landed). */
  apply: (scope: ClientToolScope, payload: Record<string, unknown>, ctx: { approvalId: string; decidedBy: string }) => Promise<void>;
  /** Optional: who may decide (approve OR reject) this tool's proposals, beyond
   *  `workspace:write` in the org (e.g. only the project's lead designer). Checked
   *  before anything changes; `false` or a fault is a 403 `collab_not_decider`.
   *  Absent ⇒ any `workspace:write` member of the org. */
  mayDecide?: (scope: ClientToolScope, ctx: { userId: string }) => Promise<boolean>;
  /** Who decides, for the refusal and the review card ("the project's lead designer"). */
  deciderLabel?: string;
}

export type ClientProjectTool = ClientReadTool | ClientProposeTool;

export const MAX_PROPOSALS_PER_CALL = 10;
const MAX_KEY_CHARS = 200;
const MAX_SUMMARY_CHARS = 500;
const MAX_PAYLOAD_BYTES = 16 * 1024;

/** A tool's proposals, checked; throws a host sentence naming what is wrong. */
export function checkProposals(toolId: string, out: unknown): ClientProposal[] {
  const list = (out as { proposals?: unknown })?.proposals;
  if (!Array.isArray(list)) throw new Error(`client tool ${toolId}: run must return { proposals: [...] }`);
  if (list.length > MAX_PROPOSALS_PER_CALL) throw new Error(`client tool ${toolId}: at most ${MAX_PROPOSALS_PER_CALL} proposals per call`);
  return list.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const str = (k: string, max: number): string => {
      const v = o[k];
      if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`client tool ${toolId}: proposal ${i} needs a ${k} of 1 to ${max} characters`);
      return v;
    };
    const payload = o.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`client tool ${toolId}: proposal ${i} needs a payload object`);
    const clean = withoutScopeKeys(payload as Record<string, unknown>);
    if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_PAYLOAD_BYTES) throw new Error(`client tool ${toolId}: proposal ${i} payload is over ${MAX_PAYLOAD_BYTES} bytes`);
    return { groupKey: str('groupKey', MAX_KEY_CHARS), idempotencyKey: str('idempotencyKey', MAX_KEY_CHARS), summary: str('summary', MAX_SUMMARY_CHARS), payload: clean };
  });
}

/** Keys the host owns. A schema naming one is refused at registration; the same keys in
 *  model input are dropped before `run`, so a model cannot steer the scope. Both are
 *  checked at EVERY depth and in any spelling (`projectId`, `project_id`, `ProjectID`):
 *  a nested `filter: { projectId }` would otherwise point a tool at another project. */
export const SCOPE_KEYS: readonly string[] = ['tenantId', 'orgId', 'projectId', 'resourceId', 'resourceKind', 'grantId', 'collaboratorId', 'audience'];
const normalizeKey = (k: string): string => k.toLowerCase().replace(/[_\-\s]/g, '');
const SCOPE_KEY_FORMS = new Set(SCOPE_KEYS.map(normalizeKey));
const isScopeKey = (k: string): boolean => SCOPE_KEY_FORMS.has(normalizeKey(k));

/** Every property name a JSON Schema declares, at any depth. */
function schemaPropertyNames(schema: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32 || !schema || typeof schema !== 'object') return out;
  if (Array.isArray(schema)) { for (const s of schema) schemaPropertyNames(s, out, depth + 1); return out; }
  const o = schema as Record<string, unknown>;
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    const map = o[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [name, sub] of Object.entries(map as Record<string, unknown>)) {
        if (key === 'properties' || key === 'dependentSchemas') out.push(name);
        schemaPropertyNames(sub, out, depth + 1);
      }
    }
  }
  if (Array.isArray(o.required)) for (const r of o.required) if (typeof r === 'string') out.push(r);
  for (const key of ['items', 'prefixItems', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'contains']) {
    schemaPropertyNames(o[key], out, depth + 1);
  }
  return out;
}

const tools = new Map<string, ClientProjectTool>();

export function registerClientProjectTool(tool: ClientProjectTool): void {
  // The kind is in the id so the capability firewall's prefix row for that kind
  // (`openwop:client.project`) classifies it; any other id falls to treat-as-risky.
  if (!tool.id.startsWith(`openwop:client.${tool.kind}.`)) throw new Error(`client tool ${tool.id}: ids start with openwop:client.${tool.kind}.`);
  const effect = (tool as { effect: string }).effect;
  if (effect !== 'read' && effect !== 'propose') throw new Error(`client tool ${tool.id}: effect must be 'read' or 'propose'`);
  if (tool.effect === 'propose' && typeof tool.apply !== 'function') throw new Error(`client tool ${tool.id}: a propose tool needs apply()`);
  const named = [...new Set(schemaPropertyNames(tool.inputSchema).filter(isScopeKey))];
  if (named.length > 0) throw new Error(`client tool ${tool.id}: the input schema names host-owned scope keys (${named.join(', ')})`);
  const prior = tools.get(tool.id);
  if (prior && prior.featureId !== tool.featureId) throw new Error(`client tool ${tool.id}: already registered by ${prior.featureId}`);
  tools.set(tool.id, tool);
}

/** The tools a grant on `kind` with `actions` may use, in registration order. */
export function clientToolsFor(kind: string, actions: readonly string[]): ClientProjectTool[] {
  return [...tools.values()].filter((t) => t.kind === kind && actions.includes(t.action));
}

/** Every registered client tool id (the agent-prompt tool-id lint reads this). */
export function clientProjectTool(id: string): ClientProjectTool | undefined {
  return tools.get(id);
}

export function clientProjectToolIds(): string[] {
  return [...tools.keys()];
}

export function clientToolDef(tool: ClientProjectTool): AgentToolDef {
  return { name: tool.id, description: tool.description, inputSchema: tool.inputSchema };
}

/** The model's input without any host-owned scope key, at any depth and in any
 *  spelling. (The tool loop has already validated it against `inputSchema`.) */
export function withoutScopeKeys(input: Record<string, unknown>): Record<string, unknown> {
  const strip = (v: unknown, depth: number): unknown => {
    if (depth > 32 || !v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!isScopeKey(k)) out[k] = strip(x, depth + 1);
    return out;
  };
  return strip(input ?? {}, 0) as Record<string, unknown>;
}

