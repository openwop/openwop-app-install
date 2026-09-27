/**
 * Product documentation surface (ADR 0392) — a thin feature-package composing
 * CMS (authoring) + Publishing (public serve + SEO) + KB (chat-RAG, Phase 2) +
 * MCP (external-agent docs tools, Phase 3). Owns no store: docs are CMS pages
 * with `collection:'docs'`. Toggle OFF ⇒ no docs nav surface, no KB sync.
 *
 * @see docs/adr/0392-product-docs-surface.md
 */
import type { BackendFeature } from '../types.js';
import { registerDocsRoutes } from './routes.js';
import { onCmsPageLifecycle } from '../../host/cmsPageLifecycle.js';
import { syncDocsPage } from './docsKnowledgeService.js';
import { buildDocsSurface } from './surface.js';

export const docsFeature: BackendFeature = {
  id: 'docs',
  registerRoutes: (deps) => {
    registerDocsRoutes(deps);
    // ADR 0392 Phase 2 — keep the managed docs KB collection in lockstep with
    // published docs pages so the ONE chat answers over docs. CMS fires, we
    // sync; CMS never imports docs. Keyed registration (repeat boots overwrite).
    onCmsPageLifecycle('docs.kbSync', syncDocsPage);
  },
  // ADR 0392 Phase 3 — ctx.features.docs, the scope-bound seam the MCP nodes
  // read through (never kbService directly).
  surface: { id: 'docs', build: buildDocsSurface },
  requiredPacks: [
    { name: 'feature.docs.nodes', version: '1.0.0' },
    { name: 'core.openwop.mcp', version: '1.1.3' },
  ],
  toggleDefault: {
    id: 'docs',
    label: 'Product documentation',
    description:
      'A public reference-docs surface: pages authored in the CMS docs collection, served at /docs, answerable by the AI chat (RAG), and reachable by external agents via MCP tools. Composes CMS, Publishing, KB, and the MCP server. OFF by default.',
    category: 'Content',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'docs',
  },
};
