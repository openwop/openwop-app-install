/**
 * A2 — a minimal, REAL tool catalog + executor for live manifest-agent dispatch.
 *
 * A1 (agentDispatch.ts) added the observe→act loop but left `resolveTool` /
 * `executeTool` to the host. This wires that seam to actual host capabilities so
 * the loop runs end-to-end in the app: an agent whose `toolAllowlist` includes a
 * built-in tool id, dispatched with that tool offered, will have the model call
 * it and the host execute it for real.
 *
 * Built-ins are `openwop:`-scoped (RFC 0078 catalog `source: "node-pack"`-class
 * for the Core tools) and back onto existing in-memory host surfaces — starting
 * with the self-contained, network-free knowledge RAG surface. Adding a built-in
 * is one `BuiltinTool` entry; a production host would project its full RFC 0078
 * tool catalog + an MCP/HTTP executor here instead.
 */

import { createKnowledgeSurface } from './knowledgeSurface.js';
import { createWebResearchSurface } from './webResearchSurface.js';
import { extractToolErrorCode } from './toolHooks.js';
import { LeaseLostError } from './runEffectContext.js';
import type { BundleScope } from './inMemorySurfaces.js';
import type { TurnRunDispatchSink } from './turnRunDispatch.js';
import type { AgentToolDef, ExecuteAgentTool, ResolveAgentTool } from './agentDispatch.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { featureAccessRefusal } from './workflowFeatureGate.js';
import { toolError } from './agentToolKit.js';
import type { NodeContext } from '../executor/types.js';
import { createSandboxRunner } from './sandboxAdapter.js';
import { getAgentProfile } from './agentProfileService.js';
import { createHash } from 'node:crypto';
import { createCard, ensureSubjectBoard, getCard, notifyBoardChanged, todoColumnOf } from './kanbanService.js';
import { getRosterEntry } from './rosterService.js';
import { persistRunArtifact, runArtifactKey } from './runArtifactStore.js';
import { chatArtifactRunId } from './chatArtifactScope.js';

export interface BuiltinTool {
  def: AgentToolDef;
  /** RFC 0137 §F1 — does this tool's RESULT carry content the host did not author?
   *
   *  REQUIRED, deliberately. It was optional, and 166 of 168 registrations
   *  therefore defaulted to `trusted` — a fail-OPEN default on a security
   *  boundary, and a new tool returning attacker-controlled bytes would have
   *  shipped unfenced with no test firing. Required makes the COMPILER the
   *  ratchet: a tool cannot be registered without a decision, which is
   *  complete-by-construction rather than an allowlist that rots.
   *
   *  THE RULE — apply in this order:
   *
   *  1. `'untrusted'` if a principal OUTSIDE the agent operator's trust boundary
   *     can write into the store this reads. Ingress in this host: public form
   *     submit, the chat-widget public gateway, the anon lane, device inbound
   *     (`routes/messaging.ts`), trigger ingest (`routes/triggerBridge.ts`),
   *     connection inbound, CSV/file import, external API sync, web fetch.
   *     NOT just "came from a form" — per-row provenance does not exist and must
   *     not be invented; classify the TOOL, not the row.
   *
   *  2. `'untrusted'` if the result CARRIES THROUGH attacker-controlled TEXT,
   *     even when the host computed its shape. "top 5 ticket subjects" is
   *     untrusted (verbatim strings); "47 open tickets" is trusted (a number the
   *     host computed). Aggregation does not launder text.
   *
   *  3. `'trusted'` otherwise — host-authored schemas, diagnostics, catalogs,
   *     counts, ids, enum states, timestamps. Fencing these buries diagnostics
   *     in a data-only wrapper and burns context for nothing.
   *
   *  A FACTORY that builds tools MUST take this as a parameter rather than
   *  hardcoding it, or it collapses N per-tool decisions into one and defeats
   *  the ratchet (see `features/commerce/agentTools.ts` `readTool`). */
  contentTrust: 'trusted' | 'untrusted';
  /** ADR 0784 — can a call CHANGE anything? REQUIRED, the `contentTrust` way:
   *  the compiler is the ratchet. `'write'` if a call can change anything durable
   *  in this host (rows, cards, artifacts, canvases, settings, memory) or cause
   *  an effect outside it (email/SMS/push, webhook, payment, post, connector
   *  write). `'read'` otherwise, including external READS and pure compute. An
   *  argument-dependent tool (`preview | apply`) is `'write'`. DISPLAY ONLY (the
   *  turn receipt): never an input to gating, capability or permission checks. */
  effect: 'read' | 'write';
  /**
   * ADR 0604 (TOCC-2) — does this tool's RESULT carry a CLOSED WORLD the model
   * must cite back exactly? Set `true` for a JSON Schema, an enum, a catalog of
   * the only legal ids, or a design/document body whose element list IS the
   * contract. Omit for data rows, counts, acks and free text.
   *
   * WHAT IT CONTROLS. The `lossy` compaction mode elides long arrays to
   * `head + {_elided:N} + tail`. An enum truncated that way is a LIE the model
   * cannot detect: it authors against a catalog that is not this host's, and the
   * result is refused later by a validator whose message it has no way to
   * connect to a truncated list it was never told was truncated. Declaring the
   * property here makes exemption DERIVED (`isSchemaReadExempt`) instead of
   * remembered in a hand-kept array.
   *
   * WHY OPTIONAL, WHEN `contentTrust` NEXT DOOR IS REQUIRED. `contentTrust`
   * guards a SECURITY boundary and its fail-open default silently unfenced 166
   * of 168 registrations, so the compiler had to be the ratchet. Here the
   * default lands a tool in the mode that is off by default and opt-in per
   * agent, and a required field would force a judgment at 201 sites in one pass
   * — which is a fail-open wearing a ratchet's clothes, because ~180 of those
   * judgments would be a reflexive `false`. The ratchet is instead
   * `test/schema-read-exemption-completeness.test.ts`, which enumerates
   * `builtinAgentToolIds()` at RUNTIME and fails until a newly registered tool
   * is classified. A runtime denominator cannot be a floor; a static census of
   * this map provably can, because it is seeded by two spreads and then MUTATED
   * by `registerFeatureAgentTool`.
   *
   * A FACTORY that builds tools MUST take this as a parameter for the same
   * reason `contentTrust` does — collapsing N decisions into one defeats it.
   */
  schemaCarrying?: true;
  /**
   * ADR 0834 D4 — does a call need the user's approval in `safe` permission mode?
   * Set it for a tool that sends model-chosen data off-host or runs model-written
   * work (a composed workflow, code) — the asks the safe-mode baseline exists for.
   * `{ reason }` is the text the held answer gives the model (e.g. pointing at a
   * reviewed alternative). DECLARED here, at the tool, so the baseline cannot miss a
   * tool the way a hand-kept name list did; `test/safe-mode-baseline-census.test.ts`
   * makes every live tool an explicit decision. Origin `baseline`: the user's own
   * bypass may skip it (ADR 0834 D2).
   */
  safeModeApproval?: true | { reason: string };
  /**
   * ADR 0954 P4 — on an ANONYMOUS surface this write may only be HELD for an
   * operator (the RFC 0132 `hitl` control), never auto-run under
   * `rate-limit-session-cap`. Set it for a write whose input a visitor can aim
   * at someone else's record (a typed email matching an existing contact). It is
   * enforced twice: a widget grant pairing such a tool with an auto-run control
   * is refused (`chat-widget/widgetService.ts`), and `authorizeAnonTool` always
   * answers `hitl` for it, so a grant saved before the rule still holds the call.
   */
  anonHitlOnly?: true;
  /** `continueTurn` (ADR 0773 B.7): host-internal, never sent to the model as-is.
   *  A string = the tool's work is unfinished, and the chat loop may send it as
   *  ONE follow-up if the model then stops without a call; `null` clears one. */
  run(input: Record<string, unknown>, scope: BundleScope): Promise<{ content: string; isError?: boolean; continueTurn?: string | null }>;
}

/**
 * ADR 0081 P3 — node-as-tool projection for LIVE agent dispatch. Only PURE compute nodes
 * (no host-surface ctx, no secrets, no egress) are projectable into ad-hoc dispatch: their
 * `execute(ctx)` reads only `ctx.config`/`ctx.inputs` and returns deterministic math, so a
 * minimal synthesized ctx is sufficient and replay-safe. Connector-backed nodes
 * (`core.bigquery.query`, `core.email.draft`) are DELIBERATELY excluded — they need the
 * full executor broker ctx (storage + acting-human Connection + connections:use) and run via
 * the meta-workflows instead; projecting them here would fork the egress path (ADR 0001).
 * An explicit allowlist (not a heuristic) — the bigquery node doesn't declare its connector
 * requirement, so a "no requires" heuristic would wrongly project it.
 */
export const PROJECTABLE_COMPUTE_NODE_TYPE_IDS: readonly string[] = [
  'feature.insights-suite.nodes.variance-compute',
  'feature.insights-suite.nodes.talent-score',
  // CFP-1 (CHAT-FIRST-PORT-AUDIT #1): pure nodes that agent packs already
  // allowlist — projecting them makes those declarations true. Each is
  // role:"pure" in its pack manifest (no host surface, no secrets, no egress).
  'core.openwop.data.jsonpath-query',
  'core.openwop.data.json-schema-validate',
  'core.flow.split-in-batches',
  'core.flow.aggregate-text',
  'feature.assistant.nodes.prioritize',
  'feature.crm.nodes.segment-vocabulary',
  'feature.crm.nodes.validate-segment',
];

/**
 * ADR 0604 (TOCC-2) — the projected compute nodes whose OUTPUT is a closed
 * vocabulary rather than a computed value. `segment-vocabulary` returns the
 * `{fields, calculatedFields, ops}` closed world that `validate-segment` and
 * `persist-segment` then ENFORCE; `validate-segment` echoes the accepted filter
 * set back. Elide either and the model authors a segment against a vocabulary
 * this host does not have.
 *
 * This is exactly the class a grep of `features/*​/agentTools.ts` cannot see —
 * these tools are PROJECTED from a node-typeId array, not registered — which is
 * why the exemption list was a floor by construction and not by oversight.
 */
const SCHEMA_CARRYING_PROJECTED_TYPE_IDS: ReadonlySet<string> = new Set([
  'feature.crm.nodes.segment-vocabulary',
  'feature.crm.nodes.validate-segment',
]);

/**
 * ADR 0820 §7 / G7 — the feature that owns a projected compute node: a
 * `feature.<id>.nodes.*` typeId belongs to feature `<id>` (the node pack's own
 * namespace, which IS the toggle id for every projected pack today:
 * insights-suite, crm, assistant). `core.*` nodes are core and never gated.
 */
export function computeNodeOwningFeature(typeId: string): string | null {
  const m = /^feature\.([a-z0-9-]+)\.nodes\./.exec(typeId);
  return m ? m[1]! : null;
}

function computeNodeTool(typeId: string, effect: BuiltinTool['effect']): BuiltinTool {
  return {
    // RFC 0137 §F1 — a compute node returns whatever its inputs produced; the caller supplies them
    contentTrust: 'untrusted',
    effect,
    ...(SCHEMA_CARRYING_PROJECTED_TYPE_IDS.has(typeId) ? { schemaCarrying: true as const } : {}),
    def: {
      name: `openwop:${typeId}`,
      description: `Run the ${typeId} compute node — pure, deterministic, no external calls. Pass the node's inputs as the tool arguments.`,
      // Permissive: the compute nodes defend their own inputs (numeric coercion,
      // required-field checks). A precise schema would duplicate the node-catalog schema.
      inputSchema: { type: 'object', additionalProperties: true },
    },
    async run(input, scope) {
      // ADR 0820 §7 / G7 — a projected FEATURE node is that feature's product:
      // toggle + plan, the typed refusals every feature tool uses. A feature with
      // no toggle (always-on) resolves null ⇒ served. Fail-closed on a read error.
      const featureId = computeNodeOwningFeature(typeId);
      if (featureId) {
        const refusal = await featureAccessRefusal(featureId, scope.tenantId, scope.actingUserId ? { userId: scope.actingUserId } : {});
        if (refusal === 'plan') return toolError('not_entitled', `${featureId} is not included in this workspace's plan.`);
        if (refusal === 'unresolved') return toolError('feature_unavailable', `${featureId} could not be checked right now — tell the user to try again shortly.`);
        if (refusal === 'toggle') return toolError('feature_disabled', `The ${featureId} feature is not enabled for this workspace.`);
      }
      const node = await getNodeRegistry().resolve(typeId);
      if (!node) return { content: `node not available: ${typeId}`, isError: true };
      const ctx: NodeContext = {
        runId: `agent-tool:${scope.tenantId}`,
        nodeId: typeId,
        tenantId: scope.tenantId,
        inputs: input,
        config: {},
        configurable: {},
        attempt: 1,
        secrets: {},
        emit: async () => ({ eventId: '', sequence: 0 }),
      };
      const outcome = await node.execute(ctx);
      if (outcome.status === 'success') return { content: JSON.stringify(outcome.outputs ?? {}) };
      if (outcome.status === 'failure') return { content: JSON.stringify(outcome.error ?? { code: 'node_failed' }), isError: true };
      // A pure compute node never suspends; treat anything else as an error.
      return { content: JSON.stringify({ code: 'node_unexpected_outcome' }), isError: true };
    },
  };
}

/** ADR 0277 P2 — the executing agent's bound collections, when the scope names
 *  an agent and its profile carries a knowledge binding. This makes the
 *  advisory-board "Shared knowledge" grant a real SCOPING contract at tool
 *  time: a bound agent's knowledge tools read its bound KBs, not the whole
 *  tenant. Absent agent / empty binding ⇒ undefined (tenant-wide — the
 *  unchanged behavior for agent-less workflow scopes). Fail-soft: a profile
 *  read failure degrades to tenant-wide rather than failing the tool. */
async function boundCollectionIds(scope: BundleScope): Promise<string[] | undefined> {
  if (!scope.agentProfileId) return undefined;
  try {
    const ids = (await getAgentProfile(scope.tenantId, scope.agentProfileId))?.knowledge?.collectionIds ?? [];
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

/** `openwop:knowledge.search` — retrieval over the workspace's knowledge-base
 *  collections (`tenantRetrieve`), or the seeded demo corpus when it has none. The
 *  canonical first real agent tool.
 *
 *  ADR 0904 D11 — this said "lexical RAG… deterministic, no network", which was false
 *  under BYOK embeddings and is false for every tenant once the operator embedder (D1)
 *  is on: the query may be embedded by a provider over the network. The model-facing
 *  text is now true in EVERY configuration rather than generated per tenant — one fixed
 *  string keeps the tool block byte-stable for prompt caching (ADR 0315) — and is pinned
 *  by `test/agent-prompt-tool-ids.test.ts`. */
/** ADR 0904 D11 — the model-facing descriptions. True whatever embedder is configured
 *  (local hash, BYOK, or the operator's): they never promise "lexical" or "no network". */
export const KNOWLEDGE_TOOL_DESCRIPTION =
  "Search this workspace's knowledge base (semantic and keyword retrieval over its document collections; a built-in demo corpus when it has none). Returns the most relevant chunks with their sources and a 0-1 relevanceScore. Use it to ground an answer in the knowledge base before responding.";
export const KNOWLEDGE_RETRIEVER_DESCRIPTION =
  "Retrieve the most relevant passages from this workspace's knowledge base (semantic and keyword retrieval over its document collections) to ground an answer. Returns the matching chunks and their sources.";

const KNOWLEDGE_SEARCH: BuiltinTool = {
  // RFC 0137 §F1 — KB chunks carry per-chunk contentTrust — synced/ingested docs are untrusted
  contentTrust: 'untrusted',
  effect: 'read',
  def: {
    name: 'openwop:knowledge.search',
    description:
      KNOWLEDGE_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'The search query.' },
        resultLimit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max chunks to return (default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async run(input, scope) {
    const surface = createKnowledgeSurface(scope);
    const collectionIds = await boundCollectionIds(scope);
    const out = await surface.retrieve({
      query: String(input.query ?? ''),
      resultLimit: typeof input.resultLimit === 'number' ? input.resultLimit : 5,
      ...(collectionIds ? { collectionIds } : {}),
    });
    return { content: JSON.stringify(out) };
  },
};

/** `openwop:ai.research.web` — live web research (search → fetch → cite) via the
 *  host's `webResearch` surface. This is the canonical EGRESS agent tool, and
 *  the first to cross the "network-free" line the compute/knowledge builtins
 *  hold (ADR 0081 P3). That line is deliberately crossed: the surface is
 *  tenant-scoped, SSRF-guarded (`webResearchSurface` blocks private/loopback +
 *  non-http(s) URLs), and provider-gated (it returns a demo placeholder until a
 *  search key — `OPENWOP_WEBSEARCH_API_KEY` or a BYOK `web-search` secret — is
 *  configured), so it is safe to offer on a scoped agent turn. Without it, a
 *  research agent (e.g. core.openwop.agents.deep-research) has NO resolvable
 *  tool and dead-ends at "Retrieving evidence" (ADR 0089). */
const WEB_RESEARCH: BuiltinTool = {
  // RFC 0137 §F1 — WEB SEARCH RESULTS — the canonical prompt-injection vector
  contentTrust: 'untrusted',
  effect: 'read',
  def: {
    name: 'openwop:ai.research.web',
    description:
      'Research the live web: runs a search, fetches the top results, and returns their content as citations. Use it to ground an answer in current external sources before responding. Returns { citations: [{ url, title, snippet, content }], engine }.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'The search query.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 10, description: 'Max sources to fetch (default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async run(input, scope) {
    const surface = createWebResearchSurface(scope);
    const out = await surface.research({
      query: String(input.query ?? ''),
      ...(typeof input.maxResults === 'number' ? { maxResults: input.maxResults } : {}),
    });
    // HONESTY (ADR 0101): with no search provider configured the surface returns
    // a `demo` placeholder, not real hits. Tell the model explicitly so it does
    // NOT present an un-grounded answer as researched.
    if (out.engine === 'demo') {
      return {
        content: JSON.stringify({
          note: 'WEB SEARCH NOT CONFIGURED — these are NOT live results. No search provider key is set on this host. Answer from your own knowledge and tell the user that live web search is unavailable here.',
          ...out,
        }),
      };
    }
    return { content: JSON.stringify(out) };
  },
};

/** `openwop:core.openwop.http.fetch` — fetch a specific URL the agent already
 *  has (e.g. a citation it wants to read in full). EGRESS, via the same
 *  SSRF-guarded `webResearch.fetchBatch` (blocks private/loopback + non-http(s));
 *  unlike web search it needs NO provider key. */
const HTTP_FETCH: BuiltinTool = {
  // RFC 0137 §F1 — arbitrary remote body from an attacker-choosable host
  contentTrust: 'untrusted',
  effect: 'read',
  def: {
    name: 'openwop:core.openwop.http.fetch',
    description:
      'Fetch a single web page by URL (SSRF-guarded) and return its extracted text. Use it to read a specific page in full when you already have its URL. Returns { pages: [{ url, status, title, extractedText }] }.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to fetch (http/https).' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  async run(input, scope) {
    const url = String(input.url ?? '');
    if (!url) return { content: JSON.stringify({ error: 'url required' }), isError: true };
    const out = await createWebResearchSurface(scope).fetchBatch({ urls: [url] });
    return { content: JSON.stringify(out) };
  },
};

/** RAG retriever ids (`core.rag.retriever-basic`, `…retriever-contextual-compression`)
 *  that agent packs declare. The `core.openwop.rag` pack's retriever NODES throw
 *  HOST_CAPABILITY_MISSING here; we back these ids with the host's knowledge surface
 *  (the same retrieval behind `openwop:knowledge.search` — hybrid semantic + keyword
 *  over the workspace's KB, ADR 0904 D11) so a research agent's "retrieve from the KB"
 *  step actually returns grounded chunks. */
function knowledgeRetrieverTool(name: string, effect: BuiltinTool['effect']): BuiltinTool {
  return {
    // RFC 0137 §F1 — retrieved corpus passages — same taint as knowledge.search
    contentTrust: 'untrusted',
    effect,
    def: {
      name,
      description:
        KNOWLEDGE_RETRIEVER_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'The retrieval query.' },
          resultLimit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max chunks to return (default 5).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const collectionIds = await boundCollectionIds(scope);
      const out = await createKnowledgeSurface(scope).retrieve({
        query: String(input.query ?? ''),
        resultLimit: typeof input.resultLimit === 'number' ? input.resultLimit : 5,
        ...(collectionIds ? { collectionIds } : {}),
      });
      return { content: JSON.stringify(out) };
    },
  };
}

const RAG_RETRIEVER_IDS = ['openwop:core.rag.retriever-basic', 'openwop:core.rag.retriever-contextual-compression'] as const;

/** `openwop:feature.code-exec.nodes.run` — run a short program in the host sandbox (ADR 0114 /
 *  0146). This is the AGENT-TOOL projection of the code-exec node so the Code Interpreter persona
 *  can actually invoke it through chat (the node itself runs as a workflow node with the executor's
 *  full ctx; the conversational tool loop has no `suspend`/`ctx.runSandboxedCode`, so we wire the
 *  sandbox runner directly here). `createSandboxRunner(tenantId)` resolves the active executor —
 *  the in-process WASI runtime (default), an external Code-API, or honest-off — and ENFORCES the
 *  per-tenant daily budget. The sandbox is sound (no host fs/env/network escape) + wall-clock- and
 *  budget-bounded; the chat path executes directly (no inline HITL card — the user asked the agent
 *  to run code and the boundary holds), whereas the workflow-node path keeps the HITL gate.
 *  CORRECTED (ADR 0995): "executes directly" is true of THIS function only. The chat, run and voice
 *  lanes hold the call for approval first in safe mode (`SENSITIVE_APPROVAL_TOOLS`, ADR 0150/0834),
 *  and the held call shows its arguments, the code included. */
/** ADR 0311 D1 — `openwop:kanban.add-todo`: the THIRD grounding path for an agent's
 *  promises (do it now / schedule it, ADR 0309 / FILE it as a todo and say so). Files a
 *  real `host.kanban` card in the agent's own board's `todo` column — the exact column
 *  the roster heartbeat consumes (heartbeatService), so a filed todo enters the existing
 *  agents-propose loop ONCE a workflow is bound (per-card or the column trigger); a bare
 *  card is a visible, human-manageable backlog item, deliberately NOT auto-executed.
 *  Static CORE builtin (host.kanban is core, untoggled — the knowledge.search posture);
 *  fail-closed on the ADR 0308 floor (acting user + a specific agent). */
const KANBAN_ADD_TODO: BuiltinTool = {
  // RFC 0137 §F1 — returns a host-authored write acknowledgement, not stored content
  contentTrust: 'trusted',
  effect: 'write',
  def: {
    name: 'openwop:kanban.add-todo',
    description:
      'File something you are committing to do (but are not doing right now) as a todo card on YOUR OWN kanban '
      + 'board, visible to the user. Returns the card + board so you can report exactly what you filed. '
      + 'Use it whenever you tell the user you will handle something later and you are not scheduling it '
      + 'for a specific time. After it succeeds, tell the user the todo title and that it is on your board.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, specific todo title (what you committed to).' },
        detail: { type: 'string', description: 'Optional context your future work needs — self-contained.' },
        dueAtISO: { type: 'string', description: 'Optional due date, ISO-8601 WITH an explicit timezone (trailing Z or ±hh:mm).' },
      },
      required: ['title'],
    },
  },
  async run(input, scope) {
    const err = (error: string, message: string): { content: string; isError: true } => ({ content: JSON.stringify({ error, message }), isError: true });
    if (!scope.actingUserId) return err('acting_user_required', 'Todos can only be filed from a human-initiated turn.');
    const agentId = scope.agentProfileId;
    if (!agentId) return err('agent_required', 'Todos need a specific agent to own them — this turn has none.');
    const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
    if (!title) return err('validation_error', '`title` is required.');
    if (title.length > 300) return err('validation_error', '`title` must be at most 300 characters.');
    const detail = typeof input.detail === 'string' ? input.detail.trim().slice(0, 4_000) : '';
    const dueAtISO = typeof input.dueAtISO === 'string' ? input.dueAtISO.trim() : '';
    if (dueAtISO && (!/(Z|[+-]\d{2}:?\d{2})$/.test(dueAtISO) || !Number.isFinite(Date.parse(dueAtISO)))) {
      return err('validation_error', '`dueAtISO` must be a valid ISO-8601 timestamp WITH an explicit timezone.');
    }
    // The agent's own board (idempotent, deterministic id) — its `todo` column is
    // the roster heartbeat's work-intake contract.
    const board = await ensureSubjectBoard(scope.tenantId, { kind: 'agent', id: agentId });
    const todo = todoColumnOf(board);
    if (!todo) return err('no_todo_column', 'This agent\'s board has no To Do column — ask the user to add one.');
    const persona = (await getRosterEntry(scope.tenantId, agentId).catch(() => null))?.persona ?? 'Agent';
    // Deterministic id: an identical retried call returns the same card (the
    // GD-0308-1 pattern; createCard short-circuits on an existing cardId).
    const key = createHash('sha256').update([scope.runId ?? scope.tenantId, agentId, 'openwop:kanban.add-todo', title, detail, dueAtISO].join('\u0000')).digest('hex').slice(0, 32);
    const cardId = `card-todo-${key}`;
    // ADR 0774 D7 — read first, so the receipt can say whether THIS call filed
    // the card or found one an identical earlier call filed (which may since
    // have been worked, moved or completed).
    const alreadyFiled = (await getCard(cardId)) !== null;
    const card = await createCard({
      boardId: board.id,
      columnId: todo.id,
      cardId,
      title,
      ...(detail ? { description: detail } : {}),
      source: 'agent',
      sourceLabel: persona,
      createdBy: scope.actingUserId,
      // ADR 0311 P2 — the provenance chain: card → heartbeat approval → the
      // originating chat's review strip.
      ...(scope.conversationId ? { sourceConversationId: scope.conversationId } : {}),
      ...(dueAtISO ? { dueAt: new Date(Date.parse(dueAtISO)).toISOString() } : {}),
    });
    if (!alreadyFiled) notifyBoardChanged(board.id);
    // The column the card is ACTUALLY in — a deduped card may have moved on.
    const column = board.columns.find((c) => c.id === card.columnId)?.name ?? todo.name;
    return {
      content: JSON.stringify({
        filed: true,
        alreadyFiled,
        cardId: card.id,
        title: card.title,
        board: board.name,
        column,
        note: alreadyFiled
          ? `You already filed this exact todo; it is now in your board's ${column} column. Tell the user that, not that you filed it again.`
          : 'Todo filed on your board. Tell the user the exact title and that it is on your board\'s To Do column. Your heartbeat may pick it up later, and a todo with no bound workflow is proposed for the user\'s approval before anything runs — do not promise it will run on its own.',
      }),
    };
  },
};

const CODE_EXEC: BuiltinTool = {
  // RFC 0137 §F1 — arbitrary program output
  contentTrust: 'untrusted',
  effect: 'write',
  def: {
    name: 'openwop:feature.code-exec.nodes.run',
    description:
      'Run a short program in an isolated sandbox (Python by default) and return its stdout, stderr, and exit code. The sandbox has NO network and NO access to host files, env, or secrets — pass any needed data inline in the code. Use this whenever running the code is easier/more reliable than reasoning it out by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 1, description: 'The program source to execute.' },
        language: { type: 'string', description: 'Language id; default `python`.' },
        stdin: { type: 'string', description: 'Optional standard input fed to the program.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  async run(input, scope) {
    const runner = createSandboxRunner(scope.tenantId);
    if (!runner) {
      return { content: JSON.stringify({ error: 'capability_not_provided', message: 'No code-execution sandbox is configured on this host.' }), isError: true };
    }
    const code = String(input.code ?? '');
    if (code.length === 0) return { content: JSON.stringify({ error: 'validation_error', message: '`code` is required.' }), isError: true };
    const language = typeof input.language === 'string' ? input.language : 'python';
    try {
      const r = await runner({
        language,
        code,
        ...(typeof input.stdin === 'string' ? { stdin: input.stdin } : {}),
      });
      const result = { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut ?? false };
      // ADR 0114 Phase 4b (CFP A10 gap) — project the execution result as a TYPED
      // `code.execution-result` artifact (ADR 0055) so it lands in the SAME
      // workbench/Library lane as a run-produced one (the render tool's pattern).
      // Deterministic key (conversation/user + code hash) ⇒ a retried identical
      // call CAS-dedupes, never a random id on a re-runnable path. BEST-EFFORT: a
      // persist failure must NEVER fail the execution result (log + omit fields).
      let artifactFields: { artifactId?: string; artifactKey?: string } = {};
      try {
        // DATA-1 — the synthetic runId MUST carry the tenant: `runArtifactKey`
        // is `${runId}:${nodeId}` with no tenant dimension and `getRunArtifact`
        // has no tenant guard on this path, so an empty-scope bucket that
        // collapses across tenants (`adhoc`) would let two tenants running
        // identical code share ONE artifact row (tenant B silently gets A's).
        // ADR 0996 — the ONE builder; readers gate on its bucket.
        const runId = chatArtifactRunId('chat-code', scope);
        // CFPT-8 — hash the FULL execution input (language + stdin + code), not
        // `code` alone: same source run under a different language, or with
        // different stdin, is a DIFFERENT execution, so it must key to a distinct
        // artifact. Hashing code only collided those onto one CAS row, hiding a
        // genuinely different result behind a stale one.
        //
        // ADR 0995 D9 — and the RESULT. Keyed on the input alone, a second run of the same
        // code whose output differed (random numbers, the clock) got the fresh stdout in the
        // tool result and the FIRST run's artifact in the workbench, because the write is
        // insert-only. An identical retry still dedupes.
        const stdin = typeof input.stdin === 'string' ? input.stdin : '';
        const nodeId = `run:${createHash('sha256').update([language, stdin, code, JSON.stringify(result)].join('\u0000')).digest('hex').slice(0, 12)}`;
        const persisted = await persistRunArtifact({
          tenantId: scope.tenantId,
          runId,
          nodeId,
          role: 'deliverable',
          // The typed inline-artifact envelope `detectTypedArtifact` honors; the
          // payload matches the `code.execution-result` schema exactly (its
          // `additionalProperties:false` rejects any stray field).
          output: { artifact: { artifactTypeId: 'code.execution-result', payload: { ...result, language }, title: `${language} execution` } },
          now: new Date().toISOString(),
        });
        if (persisted) artifactFields = { artifactId: persisted.artifactId, artifactKey: runArtifactKey(runId, nodeId) };
      } catch { /* best-effort projection — never fail the execution over the artifact */ }
      return { content: JSON.stringify({ ...result, ...artifactFields }) };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { content: JSON.stringify({ error: err.code ?? 'sandbox_error', message: err.message ?? 'execution failed' }), isError: true };
    }
  },
};

/** XCH-ENV-5 (LLM-EXCHANGE-AUDIT Wave 5) — the generic ASK-the-app-for-schemas
 *  tool: the tool-mediated twin of the RFC 0021 `schema.request` envelope
 *  (which the chat loop now also honors, XCH-ENV-2). Serves the wider
 *  universe the envelope responder's payload contract can't: node-type
 *  schemas (the responder), canvas component catalogs (slides, app-builder,
 *  and every other registered canvas type), and artifact types. Read-only,
 *  tenant-independent (all three registries are host-global). */
const SCHEMA_LOOKUP: BuiltinTool = {
  // RFC 0137 §F1 — host-authored schema; fencing would bury the contract the model must read
  contentTrust: 'trusted',
  effect: 'read',
  // ADR 0604 (TOCC-2) — the archetype: its whole output IS the schema.
  schemaCarrying: true,
  def: {
    name: 'openwop:schema.lookup',
    description:
      'Look up the schemas the app enforces, BEFORE authoring: workflow-node type schemas (kind "node", pass names[]), '
      + 'a canvas type\'s closed component catalog (kind "canvas-component", pass canvasTypeId like "canvas.slides"), '
      + 'or the registered artifact types (kind "artifact-type", names[] optional). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['node', 'canvas-component', 'artifact-type'], description: 'Which schema family to look up.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Node typeIds (kind "node") or artifact-type ids to fetch.' },
        canvasTypeId: { type: 'string', description: 'The canvas type whose component catalog to fetch (kind "canvas-component").' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  async run(input) {
    // ADR 0785 P3 — the ONE implementation, shared with the Claude Code MCP tool.
    const { lookupAppSchemas } = await import('./schemaLookup.js');
    const r = await lookupAppSchemas(input);
    return r.ok
      ? { content: JSON.stringify(r.value) }
      : { content: JSON.stringify({ error: r.error, message: r.message }), isError: true };
  },
};

const BUILTINS: ReadonlyMap<string, BuiltinTool> = new Map<string, BuiltinTool>([
  [KNOWLEDGE_SEARCH.def.name, KNOWLEDGE_SEARCH],
  [SCHEMA_LOOKUP.def.name, SCHEMA_LOOKUP],
  [WEB_RESEARCH.def.name, WEB_RESEARCH],
  [HTTP_FETCH.def.name, HTTP_FETCH],
  [CODE_EXEC.def.name, CODE_EXEC],
  [KANBAN_ADD_TODO.def.name, KANBAN_ADD_TODO],
  ...RAG_RETRIEVER_IDS.map((id): [string, BuiltinTool] => [id, knowledgeRetrieverTool(id, 'read')]),
  ...PROJECTABLE_COMPUTE_NODE_TYPE_IDS.map((t): [string, BuiltinTool] => { const tool = computeNodeTool(t, 'read'); return [tool.def.name, tool]; }),
]);

/** The tool ids this host can offer a live agent turn. A host intersects this
 *  with the agent's `toolAllowlist` and the per-turn `availableTools`. */
export function builtinAgentToolIds(): readonly string[] {
  return [...BUILTINS.keys()];
}

/**
 * ADR 0308 D2 — feature-REGISTERED builtin tools (dependency inversion, the
 * `wireStreamAudioResolver` pattern): a feature package registers its
 * deliverable tools from its `feature.ts` init; core never imports the
 * feature, and an absent/disabled feature simply registers nothing. Registered
 * tools flow through the SAME projection + gating as the static builtins —
 * agent `toolAllowlist` default-deny → Capability Firewall → `executeTool` —
 * with zero changes to the enforcement stack. Toggle honesty lives in the
 * tool's own `run` (per-tenant toggles are dynamic; registration is
 * process-wide). Last registration wins per id (feature re-init in tests).
 */
/** One registered builtin, for tests that must assert a tool's DECLARATION
 *  (e.g. RFC 0137 §F1 `contentTrust`) rather than infer it from behavior — an
 *  unregistered tool errors, and "it errored" is not evidence it opted in. */
export function builtinAgentTool(id: string): BuiltinTool | undefined {
  return BUILTINS.get(id);
}

/** ADR 0954 P4 — may this tool only be held (never auto-run) on an anon surface? */
export function isAnonHitlOnlyTool(id: string): boolean {
  return BUILTINS.get(id)?.anonHitlOnly === true;
}

/** ADR 0834 D4 — every registered tool that declares `safeModeApproval`, with its
 *  held-answer reason (undefined ⇒ the generic safe-mode reason). Read per lane build,
 *  so a feature that registers a tool late is still covered. */
export function declaredSafeModeApprovals(): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const [id, tool] of BUILTINS) {
    const d = tool.safeModeApproval;
    if (d) out.set(id, d === true ? undefined : d.reason);
  }
  return out;
}

export function registerFeatureAgentTool(tool: BuiltinTool): void {
  (BUILTINS as Map<string, BuiltinTool>).set(tool.def.name, tool);
}

/**
 * The distinct namespace prefixes of the builtin platform tools — derived from
 * `builtinAgentToolIds()` so it can't go stale (`openwop:knowledge`, `openwop:ai`,
 * `openwop:core`, `openwop:feature`). Used as `agentProfile.permissions.read`
 * tokens so the ADR 0102 per-tool gate PERMITS the host's builtin tools (a
 * permission token prefix-matches `<ns>.<rest>`); the agent's domain allowlist +
 * `never`-deny still govern external/domain actions. Forward-compatible: a new
 * builtin under one of these namespaces is auto-permitted.
 */
export function builtinToolNamespaces(): string[] {
  return [...new Set(builtinAgentToolIds().map((id) => id.split('.')[0]!))];
}

/**
 * ADR 0324 — the ONE composer of a conversational tool call's execution scope.
 * Every transport that lets a model run agent tools on behalf of a human — the
 * chat tool loop (`conversationToolLoop`) and the realtime voice bridge
 * (`toolBridge.executeRealtimeToolCall`) — MUST build its executor through this
 * function, never through a hand-rolled `createAgentToolProvider({...})` literal.
 * The deliverable tools fail closed on scope fields (`actingUserId` — ADR 0308;
 * `conversationId` — ADR 0309), so a transport that assembles its own scope and
 * omits one silently loses capabilities that work everywhere else (the "voice
 * Iris can't draft what chat Iris drafts" incident). A new scope field lands
 * here once and reaches every transport, or reaches none — kept honest by the
 * voice-tool-parity test, which pins both call sites to this composer.
 */
export interface AgentToolCallScope {
  tenantId: string;
  /** The turn's run id (`runId` for chat; `voice:<sessionId>` for realtime). */
  runId: string;
  /** The executing agent's profile id (ADR 0277 P2 — knowledge scoping). */
  agentProfileId?: string | undefined;
  /** The human the tools act for (ADR 0024 §4 / ADR 0308). Deliverable tools
   *  (documents.draft, kanban.add-todo, …) fail closed without it. */
  actingUserId?: string | undefined;
  /** The human's OWN personal tenant (ADR 0627 D3 / review S2 — the request's
   *  `personalTenantOf(req)`, via `run.metadata.personalTenant`), so a req-less
   *  tenant gate can grant the implicit owner of an `anon:`/`user:` sandbox. */
  personalTenant?: string | undefined;
  /** ADR 0832 D3 — the member who caused an actorless turn (a channel post), via
   *  `run.metadata.orgScopeSubject`. Read only by org-membership floors; the
   *  tools still act for nobody. */
  orgScopeSubject?: string | undefined;
  /** The conversation the call runs inside (ADR 0309 — the unforgeable
   *  delivery destination for schedule-followup). */
  conversationId?: string | undefined;
  /** Turn-scoped sink for workflow runs a tool ignites, so the EXCHANGE (the one
   *  turnIndex allocator, and the owner of the response) materializes the
   *  `workflow_run` bubble rather than the tool racing it out-of-band —
   *  `host/turnRunDispatch.ts`. The conversation transport supplies it; the
   *  realtime voice bridge does not, and its tools take the documented,
   *  behavior-preserving direct-append fallback. */
  onRunDispatched?: TurnRunDispatchSink | undefined;
}

export function createScopedAgentToolProvider(
  scope: AgentToolCallScope,
): { resolveTool: ResolveAgentTool; executeTool: ExecuteAgentTool } {
  return createAgentToolProvider({
    tenantId: scope.tenantId,
    runId: scope.runId,
    ...(scope.agentProfileId ? { agentProfileId: scope.agentProfileId } : {}),
    ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}),
    ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}),
    ...(scope.orgScopeSubject ? { orgScopeSubject: scope.orgScopeSubject } : {}),
    ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
    ...(scope.onRunDispatched ? { onRunDispatched: scope.onRunDispatched } : {}),
  });
}

/**
 * Build the `{ resolveTool, executeTool }` pair `runAgentDispatchLive` needs to
 * run a real tool loop, bound to a tenant/run scope (CTI-1).
 */
export function createAgentToolProvider(
  scope: BundleScope,
): { resolveTool: ResolveAgentTool; executeTool: ExecuteAgentTool } {
  return {
    resolveTool: (name) => BUILTINS.get(name)?.def,
    executeTool: async ({ name, input }) => {
      const tool = BUILTINS.get(name);
      if (!tool) return { content: `unknown tool: ${name}`, isError: true };
      try {
        // Deliberately NOT fenced here. RFC 0137 §F1 fencing happens at MODEL
        // MESSAGE CONSTRUCTION (`toModelToolResult`), not at tool execution:
        // this result is a STRUCTURED contract that programmatic callers
        // `JSON.parse`, and wrapping it in prose here corrupts them. Fencing at
        // this layer broke `cfp1-small-packs-agent-tools.test.ts` with
        // `SyntaxError: Unexpected token 'B', "BEGIN UNTR"`.
        return await tool.run(input, scope);
      } catch (err) {
        // ADR 0764 (grade-code CHATCD-3) — a LOST LEASE is not a tool failure: this
        // instance no longer owns the run, and swallowing it into a tool error let
        // the former owner keep looping its agent and complete the node. Propagate
        // it to the executor's quiet abandon path (`executor.ts` re-throws it too).
        if (err instanceof LeaseLostError) throw err;
        // RFC 0064 §F — preserve the THROWN error's structured code so the
        // dispatcher can name it on `agent.toolReturned.error.code` and suppress
        // `durationMs` for a capability-precondition gate (e.g. `featureSurfaces`
        // throwing `host_capability_disabled`, an `AiProviderError`). Without this
        // the code is lost here and every throw degrades to `tool_execution_failed`
        // with `durationMs` falsely present — the WFAU-4 wire-honesty gap.
        return { content: `tool_failed: ${err instanceof Error ? err.message : String(err)}`, isError: true, errorCode: extractToolErrorCode(err) };
      }
    },
  };
}
