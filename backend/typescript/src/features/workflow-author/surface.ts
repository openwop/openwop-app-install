/**
 * Workflow-author workflow surface (ADR 0072 / ADR 0014 Phase 1) — the typed
 * `ctx.features['workflow-author']` the meta-workflow's nodes call. Toggle-gated
 * at the registry seam (featureSurfaces.gate, tenant granularity). The catalog +
 * registry it reads/writes are host-global; tenant isolation for the AUTHORED
 * workflow is enforced by the shared registration path it persists through.
 *
 * @see docs/adr/0072-ai-workflow-authoring.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import { resolveDisabledPacks } from '../../host/packVisibility.js';
import { parseFieldContract } from '../../host/preserveDroppedFields.js';
import {
  buildAuthoringCatalog,
  validateAuthoredWorkflow,
  persistAuthoredWorkflow,
  readAuthoredWorkflow,
  listAuthoredWorkflows,
} from './workflowAuthorService.js';

export function buildWorkflowAuthorSurface(scope: BundleScope): FeatureSurface {
  return {
    /** The legal building-block menu: runnable, schema-resolved nodes (plus the
     *  list of nodes withheld, with reasons) the authoring brain plans against.
     *  ADR 0194 P3: tenant-curated — a workspace-disabled pack's nodes are
     *  excluded, so the in-run author sees the same menu as the palette. */
    getCatalog: async () => {
      const c = buildAuthoringCatalog({ disabledPacks: await resolveDisabledPacks(scope.tenantId) });
      return { nodes: c.nodes, excluded: c.excluded };
    },

    /** XCH-WFA-1 (LLM-EXCHANGE-AUDIT Wave 4) — the READ side authoring never
     *  had: fetch an EXISTING registered definition so a revision starts from
     *  the real workflow instead of blind re-authoring. TENANT-SCOPED (ADR 0163
     *  IDOR read guard): the caller reads its OWN authored workflows + built-ins;
     *  a workflow authored by another tenant is an indistinguishable miss. */
    getWorkflow: async (args) => {
      const workflowId = String((args ?? {}).workflowId ?? '');
      if (!workflowId) return { found: false };
      return readAuthoredWorkflow(workflowId, { tenantId: scope.tenantId });
    },

    /** The registered-workflow index (compact — id + authoring metadata name/
     *  description when present), TENANT-SCOPED: the caller's own authored
     *  workflows + built-ins, never another tenant's (ADR 0163). */
    listWorkflows: async () => ({
      workflows: await listAuthoredWorkflows({ tenantId: scope.tenantId }),
    }),

    /** Validate a candidate WorkflowDefinition WITHOUT persisting; returns
     *  `{ ok, errors }` so the draft node can repair on the errors. */
    validateDraft: async (args) => {
      const v = validateAuthoredWorkflow((args ?? {}).definition);
      return { ok: v.ok, errors: v.errors };
    },

    /** Validate AND register a candidate through the shared registration path,
     *  tenant-scoped (records ownership + refuses overwriting a built-in or
     *  another tenant's workflow — ADR 0163). Throws on any structural /
     *  capability / closed-world / ownership violation. */
    persistDraft: async (args) => {
      // ADR 0595 §Correction 1 — `clearFields` is the ADR 0524 Phase E0
      // declaration, reached from a lane that has no HTTP request to carry the
      // `x-openwop-field-contract` header. Parsed by that header's OWN parser
      // (it already accepts the array form), so the two lanes can never drift
      // on which tokens are honoured or on the closed-world drop of unknown ones.
      const declaredFields = parseFieldContract((args ?? {}).clearFields);
      const out = await persistAuthoredWorkflow((args ?? {}).definition, {
        tenantId: scope.tenantId,
        ...(declaredFields ? { declaredFields } : {}),
      });
      return {
        workflowId: out.workflowId,
        nodeCount: out.nodeCount,
        // ADR 0595 / ADR 0524 §5 — a merge nobody can see is a silent success.
        // The node relays it into its run outputs (`persist.output.schema.json`
        // declares it) so the disclosure survives to the surface the user reads.
        ...(out.preservedFields ? { preservedFields: out.preservedFields } : {}),
      };
    },
  };
}
