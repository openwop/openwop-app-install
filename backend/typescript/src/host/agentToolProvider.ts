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
import type { BundleScope } from './inMemorySurfaces.js';
import type { AgentToolDef, ExecuteAgentTool, ResolveAgentTool } from './agentDispatch.js';

interface BuiltinTool {
  def: AgentToolDef;
  run(input: Record<string, unknown>, scope: BundleScope): Promise<{ content: string; isError?: boolean }>;
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

const BUILTINS: ReadonlyMap<string, BuiltinTool> = new Map([[KNOWLEDGE_SEARCH.def.name, KNOWLEDGE_SEARCH]]);

/** The tool ids this host can offer a live agent turn. A host intersects this
 *  with the agent's `toolAllowlist` and the per-turn `availableTools`. */
export function builtinAgentToolIds(): readonly string[] {
  return [...BUILTINS.keys()];
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
