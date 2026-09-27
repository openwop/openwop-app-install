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
import type { BundleScope } from './inMemorySurfaces.js';
import type { TurnRunDispatchSink } from './turnRunDispatch.js';
import type { AgentToolDef, ExecuteAgentTool, ResolveAgentTool } from './agentDispatch.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import type { NodeContext } from '../executor/types.js';
import { createSandboxRunner } from './sandboxAdapter.js';
import { getAgentProfile } from './agentProfileService.js';
import { createHash } from 'node:crypto';
import { createCard, ensureSubjectBoard, notifyBoardChanged } from './kanbanService.js';
import { getRosterEntry } from './rosterService.js';
import { persistRunArtifact, runArtifactKey } from './runArtifactStore.js';

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
  run(input: Record<string, unknown>, scope: BundleScope): Promise<{ content: string; isError?: boolean }>;
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

function computeNodeTool(typeId: string): BuiltinTool {
  return {
    // RFC 0137 §F1 — a compute node returns whatever its inputs produced; the caller supplies them
    contentTrust: 'untrusted',
    ...(SCHEMA_CARRYING_PROJECTED_TYPE_IDS.has(typeId) ? { schemaCarrying: true as const } : {}),
    def: {
      name: `openwop:${typeId}`,
      description: `Run the ${typeId} compute node — pure, deterministic, no external calls. Pass the node's inputs as the tool arguments.`,
      // Permissive: the compute nodes defend their own inputs (numeric coercion,
      // required-field checks). A precise schema would duplicate the node-catalog schema.
      inputSchema: { type: 'object', additionalProperties: true },
    },
    async run(input, scope) {
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

/** `openwop:knowledge.search` — lexical RAG over the host's seeded corpus
 *  (deterministic, no network). The canonical first real agent tool. */
const KNOWLEDGE_SEARCH: BuiltinTool = {
  // RFC 0137 §F1 — KB chunks carry per-chunk contentTrust — synced/ingested docs are untrusted
  contentTrust: 'untrusted',
  def: {
    name: 'openwop:knowledge.search',
    description:
      'Search the host knowledge base (lexical retrieval over the seeded corpus). Returns the most relevant chunks and their sources. Use it to ground an answer in the knowledge base before responding.',
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
 *  that agent packs declare. The `core.openwop.rag` pack's retriever NODES need an
 *  embeddings provider + a vector DB this host does not implement (they throw
 *  HOST_CAPABILITY_MISSING). We back these ids with the host's WORKING lexical
 *  knowledge surface (the same retrieval behind `openwop:knowledge.search`) so a
 *  research agent's "retrieve from the KB" step actually returns grounded chunks
 *  — the honest available capability here (no vector store configured). */
function knowledgeRetrieverTool(name: string): BuiltinTool {
  return {
    // RFC 0137 §F1 — retrieved corpus passages — same taint as knowledge.search
    contentTrust: 'untrusted',
    def: {
      name,
      description:
        'Retrieve the most relevant passages from the host knowledge base (lexical retrieval over the seeded corpus) to ground an answer. Returns the matching chunks and their sources.',
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
 *  to run code and the boundary holds), whereas the workflow-node path keeps the HITL gate. */
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
    const todo = board.columns.find((c) => c.id === 'todo' || c.name.toLowerCase() === 'to do');
    if (!todo) return err('no_todo_column', 'This agent\'s board has no To Do column — ask the user to add one.');
    const persona = (await getRosterEntry(scope.tenantId, agentId).catch(() => null))?.persona ?? 'Agent';
    // Deterministic id: an identical retried call returns the same card (the
    // GD-0308-1 pattern; createCard short-circuits on an existing cardId).
    const key = createHash('sha256').update([scope.runId ?? scope.tenantId, agentId, 'openwop:kanban.add-todo', title, detail, dueAtISO].join('\u0000')).digest('hex').slice(0, 32);
    const card = await createCard({
      boardId: board.id,
      columnId: todo.id,
      cardId: `card-todo-${key}`,
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
    notifyBoardChanged(board.id);
    return {
      content: JSON.stringify({
        filed: true,
        cardId: card.id,
        title: card.title,
        board: board.name,
        column: 'To Do',
        note: 'Todo filed on your board. Tell the user the exact title and that it is on your board\'s To Do column. It will not run by itself unless a workflow is bound — do not promise autonomous execution.',
      }),
    };
  },
};

const CODE_EXEC: BuiltinTool = {
  // RFC 0137 §F1 — arbitrary program output
  contentTrust: 'untrusted',
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
        const runId = `chat-code:${scope.tenantId}:${scope.conversationId ?? scope.actingUserId ?? 'adhoc'}`;
        // CFPT-8 — hash the FULL execution input (language + stdin + code), not
        // `code` alone: same source run under a different language, or with
        // different stdin, is a DIFFERENT execution, so it must key to a distinct
        // artifact. Hashing code only collided those onto one CAS row, hiding a
        // genuinely different result behind a stale one.
        const stdin = typeof input.stdin === 'string' ? input.stdin : '';
        const nodeId = `run:${createHash('sha256').update([language, stdin, code].join('\u0000')).digest('hex').slice(0, 12)}`;
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
    const kind = String(input.kind ?? '');
    if (kind === 'node') {
      const names = Array.isArray(input.names) ? input.names.filter((n): n is string => typeof n === 'string') : [];
      if (!names.length) return { content: JSON.stringify({ error: 'validation_error', message: 'kind "node" needs names[] (node typeIds).' }), isError: true };
      const { buildSchemaResponse } = await import('./schemaResponder.js');
      return { content: JSON.stringify(buildSchemaResponse({ names })) };
    }
    if (kind === 'canvas-component') {
      const canvasTypeId = typeof input.canvasTypeId === 'string' ? input.canvasTypeId : '';
      if (!canvasTypeId) return { content: JSON.stringify({ error: 'validation_error', message: 'kind "canvas-component" needs canvasTypeId.' }), isError: true };
      const { listCanvasComponents, catalogPromptSchema } = await import('./canvasComponentCatalog.js');
      const components = listCanvasComponents(canvasTypeId);
      return { content: JSON.stringify({ canvasTypeId, components, promptSchema: catalogPromptSchema(canvasTypeId) }) };
    }
    if (kind === 'artifact-type') {
      const { listArtifactTypes, getArtifactType } = await import('./artifactTypes.js');
      const names = Array.isArray(input.names) ? input.names.filter((n): n is string => typeof n === 'string') : [];
      if (names.length) {
        const found = names.map((n) => {
          const t = getArtifactType(n);
          return t ? { artifactTypeId: t.artifactTypeId, title: t.title, schema: t.schema } : { artifactTypeId: n, notFound: true };
        });
        return { content: JSON.stringify({ artifactTypes: found }) };
      }
      return { content: JSON.stringify({ artifactTypes: listArtifactTypes().map((t) => ({ artifactTypeId: t.artifactTypeId, title: t.title })) }) };
    }
    return { content: JSON.stringify({ error: 'validation_error', message: `unknown kind '${kind}'.` }), isError: true };
  },
};

const BUILTINS: ReadonlyMap<string, BuiltinTool> = new Map<string, BuiltinTool>([
  [KNOWLEDGE_SEARCH.def.name, KNOWLEDGE_SEARCH],
  [SCHEMA_LOOKUP.def.name, SCHEMA_LOOKUP],
  [WEB_RESEARCH.def.name, WEB_RESEARCH],
  [HTTP_FETCH.def.name, HTTP_FETCH],
  [CODE_EXEC.def.name, CODE_EXEC],
  [KANBAN_ADD_TODO.def.name, KANBAN_ADD_TODO],
  ...RAG_RETRIEVER_IDS.map((id): [string, BuiltinTool] => [id, knowledgeRetrieverTool(id)]),
  ...PROJECTABLE_COMPUTE_NODE_TYPE_IDS.map((t): [string, BuiltinTool] => { const tool = computeNodeTool(t); return [tool.def.name, tool]; }),
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
