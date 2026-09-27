/**
 * Docs MCP tool schemas (ADR 0392 Phase 3) — the SINGLE source of truth for the
 * `docs.search` / `docs.get` tool contracts. This const feeds BOTH the MCP
 * manifest `inputSchema` (via the expose-tool workflow) AND the backing node's
 * input validation, so the two cannot drift (pinned by `docs-mcp-tool-ids.test.ts`,
 * the `agent-prompt-tool-ids` precedent).
 */

export interface McpToolSpec {
  /** The MCP tool name AND the `docs.mcp.<suffix>` workflow suffix. */
  name: string;
  description: string;
  backingType: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const DOCS_MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: 'docs_search',
    description: 'Search the published product documentation. Returns ranked hits with a title, snippet, public /docs URL, and relevance score.',
    backingType: 'feature.docs.nodes.search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'number', description: 'Max hits to return (default 8, max 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'docs_get',
    description: 'Fetch one published documentation page by its slug. Returns the title, full text, and public /docs URL.',
    backingType: 'feature.docs.nodes.get',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The docs page slug (as shown in its /docs/<slug> URL).' },
      },
      required: ['slug'],
    },
  },
] as const;
