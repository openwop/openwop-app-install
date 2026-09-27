/**
 * Research Notebooks (ADR 0084) — a thin feature-package vertical slice that
 * composes existing seams (projects + KB + subject memory/knowledge) instead of
 * adding new infrastructure (MEMORY.md no-parallel-architecture law).
 *
 * Wired by appending to BACKEND_FEATURES (features/index.ts) — zero core edits.
 * Tenant-bucketed, OFF by default (a sample/optional product surface).
 *
 * The frontend EmbeddedChatPanel targets the notebooks Research Analyst manifest
 * agent (`feature.notebooks.agents.researcher`, ADR 0084 Phase 4) — the
 * notebooks-surface analog of the KB Researcher, tool-allowlisted to the
 * notebooks node pack (ask/search over ctx.features.notebooks). Phase-2
 * owner-subject auto-grounding is agent-agnostic, so grounding is preserved and
 * agentic ask/search tools are added. Its pack (and the node pack it tools over)
 * are declared in `requiredPacks` so they are installed whenever notebooks ship.
 */

import type { BackendFeature } from '../types.js';
import { registerNotebooksRoutes } from './routes.js';
import { registerNotebooksAgentTools } from './agentTools.js';
import { buildNotebooksSurface } from './surface.js';

export const notebooksFeature: BackendFeature = {
  id: 'notebooks',
  registerRoutes: (deps) => {
    // CFP-1 — the Research Analyst's real chat tools (search / ask /
    // write-transformation), the ADR 0308 D2 feature-registered-builtin seam:
    // process-wide + inert until the researcher pack allowlists the ids; per-tenant
    // toggle + notebook-access honesty lives inside each tool's run().
    registerNotebooksAgentTools({ storage: deps.storage, hostSuite: deps.hostSuite });
    registerNotebooksRoutes(deps);
  },
  // ctx.features.notebooks (ADR 0084 / ADR 0014) — list/get sources, list notes,
  // grounded search, per-source context levels (reads) + the one justified
  // setSourceSummary write the summarize workflow makes; tenant-trusted + org-visible
  // notebooks only (subjectless run, the strategy isShared precedent).
  surface: { id: 'notebooks', build: buildNotebooksSurface },
  toggleDefault: {
    id: 'notebooks',
    label: 'Research Notebooks',
    description: 'Notebooks over a project Subject — sources (KB), notes (memory), and grounded ask/search.',
    category: 'Studio',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'notebooks',
  },
  requiredPacks: [
    // READ-only node pack over ctx.features.notebooks (ADR 0084 Phase 3) — `ask`
    // (grounded retrieve + citations, context-level-filtered) + `search`. Write/AI
    // nodes are deferred to the Transformations phase.
    { name: 'feature.notebooks.nodes', version: '1.1.0' },
    // The grounded "ask over the notebook" agent the FE chat targets — the
    // notebooks Research Analyst (ADR 0084 Phase 4), tool-allowlisted to the
    // notebooks node pack above. The notebooks-surface analog of feature.kb.agents
    // (distinct tooling); declaring its pack ensures it is present wherever
    // notebooks are enabled.
    { name: 'feature.notebooks.agents', version: '1.0.1' },
    // ADR 0087 — the `notebooks.mcp.*` expose-tool workflows reference the
    // `core.openwop.mcp.expose-tool` node, so the core MCP pack must be present
    // (the static tools/list scan reads its config; a tools/call run executes it).
    { name: 'core.openwop.mcp', version: '1.1.3' },
    // ADR 0087 OQ-1 — the HITL-gated write workflows use `core.hitl.approval-request`
    // to suspend for a human decision before the write.
    { name: 'core.openwop.hitl', version: '1.0.0' },
  ],
};
