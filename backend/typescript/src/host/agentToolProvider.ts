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
import type { BundleScope } from './inMemorySurfaces.js';
import type { AgentToolDef, ExecuteAgentTool, ResolveAgentTool } from './agentDispatch.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import type { NodeContext } from '../executor/types.js';
import { createSandboxRunner } from './sandboxAdapter.js';

interface BuiltinTool {
  def: AgentToolDef;
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
const PROJECTABLE_COMPUTE_NODE_TYPE_IDS: readonly string[] = [
  'feature.insights-suite.nodes.variance-compute',
  'feature.insights-suite.nodes.talent-score',
];

function computeNodeTool(typeId: string): BuiltinTool {
  return {
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

/** `openwop:knowledge.search` — lexical RAG over the host's seeded corpus
 *  (deterministic, no network). The canonical first real agent tool. */
const KNOWLEDGE_SEARCH: BuiltinTool = {
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
    const out = await surface.retrieve({
      query: String(input.query ?? ''),
      resultLimit: typeof input.resultLimit === 'number' ? input.resultLimit : 5,
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
      const out = await createKnowledgeSurface(scope).retrieve({
        query: String(input.query ?? ''),
        resultLimit: typeof input.resultLimit === 'number' ? input.resultLimit : 5,
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
const CODE_EXEC: BuiltinTool = {
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
    try {
      const r = await runner({
        language: typeof input.language === 'string' ? input.language : 'python',
        code,
        ...(typeof input.stdin === 'string' ? { stdin: input.stdin } : {}),
      });
      return { content: JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut ?? false }) };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { content: JSON.stringify({ error: err.code ?? 'sandbox_error', message: err.message ?? 'execution failed' }), isError: true };
    }
  },
};

const BUILTINS: ReadonlyMap<string, BuiltinTool> = new Map<string, BuiltinTool>([
  [KNOWLEDGE_SEARCH.def.name, KNOWLEDGE_SEARCH],
  [WEB_RESEARCH.def.name, WEB_RESEARCH],
  [HTTP_FETCH.def.name, HTTP_FETCH],
  [CODE_EXEC.def.name, CODE_EXEC],
  ...RAG_RETRIEVER_IDS.map((id): [string, BuiltinTool] => [id, knowledgeRetrieverTool(id)]),
  ...PROJECTABLE_COMPUTE_NODE_TYPE_IDS.map((t): [string, BuiltinTool] => { const tool = computeNodeTool(t); return [tool.def.name, tool]; }),
]);

/** The tool ids this host can offer a live agent turn. A host intersects this
 *  with the agent's `toolAllowlist` and the per-turn `availableTools`. */
export function builtinAgentToolIds(): readonly string[] {
  return [...BUILTINS.keys()];
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
        return await tool.run(input, scope);
      } catch (err) {
        return { content: `tool_failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
