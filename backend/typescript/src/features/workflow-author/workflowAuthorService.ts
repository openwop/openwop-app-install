/**
 * AI workflow-author service (ADR 0072) — the catalog-grounded authoring brain
 * behind the `workflow-author.{draft,validate,persist}` node pack and the
 * `ctx.features['workflow-author']` surface.
 *
 * Hard invariants (ADR 0072):
 *  - CLOSED-WORLD typeIds: every authored `node.typeId` MUST exist in the live
 *    node catalog — inventing one would dispatch to `unknown_typeid` at run time.
 *  - ONE validation path: structural + RFC 0022 §C gate via the SHARED
 *    `validateWorkflowDefinition` (the exact validator the registration route
 *    uses), so an authored graph can never drift from a hand-built one.
 *  - SCHEMA-too-large: nodes whose schema (>8KB) the catalog could not inline are
 *    EXCLUDED from the authoring menu + logged, rather than guessing a config.
 */

import { OpenwopError } from '../../types.js';
import type { WorkflowDefinition } from '../../executor/types.js';
import { buildNodeCatalog, findUnknownTypeIds, type CatalogNode } from '../../host/nodeCatalogBuilder.js';
import { validateWorkflowDefinition } from '../../host/workflowDefinitionValidation.js';
import { registerWorkflow } from '../../host/workflowsRegistry.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('workflow-author');

/** A node as offered to the authoring brain — the legal building block menu. */
export interface AuthorCatalogNode {
  typeId: string;
  version: string;
  label: string;
  description: string;
  category: string;
  role?: string;
  configSchema?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface AuthoringCatalog {
  /** Runnable, schema-resolved nodes the author may use. */
  nodes: AuthorCatalogNode[];
  /** Nodes deliberately withheld from the menu, with the reason. */
  excluded: Array<{ typeId: string; reason: string }>;
}

export interface DraftValidation {
  ok: boolean;
  errors: string[];
}

/** A catalog schema the route could not inline because it exceeds 8KB. */
function isSchemaTooLarge(schema: unknown): boolean {
  return !!schema && typeof schema === 'object' && '_note' in (schema as Record<string, unknown>);
}

/** Build the authoring menu from the live node catalog: drop nodes this host
 *  can't run (missing host surfaces) or whose schema couldn't be inlined. */
export function buildAuthoringCatalog(): AuthoringCatalog {
  const catalog = buildNodeCatalog();
  const nodes: AuthorCatalogNode[] = [];
  const excluded: Array<{ typeId: string; reason: string }> = [];
  for (const n of catalog) {
    if (n.missingHostSurfaces.length > 0) {
      excluded.push({ typeId: n.typeId, reason: `missing host surface(s): ${n.missingHostSurfaces.join(', ')}` });
      continue;
    }
    if (isSchemaTooLarge(n.configSchema) || isSchemaTooLarge(n.inputSchema) || isSchemaTooLarge(n.outputSchema)) {
      excluded.push({ typeId: n.typeId, reason: 'schema too large to inline (>8KB)' });
      continue;
    }
    nodes.push(toAuthorNode(n));
  }
  if (excluded.length > 0) {
    log.info('workflow_author_catalog_excluded', { count: excluded.length, typeIds: excluded.map((e) => e.typeId) });
  }
  return { nodes, excluded };
}

function toAuthorNode(n: CatalogNode): AuthorCatalogNode {
  return {
    typeId: n.typeId,
    version: n.version,
    label: n.label,
    description: n.description,
    category: n.category,
    ...(n.role ? { role: n.role } : {}),
    ...(n.configSchema !== undefined ? { configSchema: n.configSchema } : {}),
    ...(n.inputSchema !== undefined ? { inputSchema: n.inputSchema } : {}),
    ...(n.outputSchema !== undefined ? { outputSchema: n.outputSchema } : {}),
  };
}

/** The set of legal typeIds for closed-world validation: nodes this host can
 *  actually RUN (no missing host surfaces). A node withheld from the *authoring
 *  menu* only for a too-large schema is still runnable, so it stays legal; a node
 *  missing a host surface is NOT runnable here and is therefore NOT legal —
 *  authoring it would register a workflow that fails at run (ADR 0072
 *  "capability-gate honesty"). The closed-world set + check are CORE helpers
 *  (`runnableNodeTypeIds` / `findUnknownTypeIds` in `host/nodeCatalogBuilder.ts`)
 *  so any caller — not just this feature — can validate against what runs here. */

/**
 * Validate an authored candidate WITHOUT persisting. Returns structured errors
 * the draft node can repair on. Never throws on a bad candidate — that's the
 * point of the repair loop.
 */
export function validateAuthoredWorkflow(raw: unknown): DraftValidation {
  let def: WorkflowDefinition;
  try {
    def = validateWorkflowDefinition(raw);
  } catch (err) {
    const message = err instanceof OpenwopError ? err.message : String(err);
    return { ok: false, errors: [message] };
  }
  const unknown = findUnknownTypeIds(def);
  if (unknown.length > 0) {
    return {
      ok: false,
      errors: unknown.map(
        (t) => `Unknown node typeId '${t}': it is not in this host's node catalog. Only use typeIds from the provided catalog (closed-world).`,
      ),
    };
  }
  return { ok: true, errors: [] };
}

/**
 * Validate AND persist an authored candidate through the shared registration
 * path. Throws `OpenwopError` (400) on any structural / capability / closed-world
 * violation — so an invalid graph can never be registered.
 */
export function persistAuthoredWorkflow(raw: unknown): { workflowId: string; nodeCount: number } {
  const def = validateWorkflowDefinition(raw); // structural + RFC 0022 §C gate (throws)
  const unknown = findUnknownTypeIds(def);
  if (unknown.length > 0) {
    throw new OpenwopError(
      'validation_error',
      `Authored workflow references unknown node typeId(s): ${unknown.join(', ')}. Every typeId MUST exist in this host's node catalog (closed-world).`,
      400,
      { unknownTypeIds: unknown },
    );
  }
  registerWorkflow(def);
  log.info('workflow_author_persisted', { workflowId: def.workflowId, nodeCount: def.nodes.length });
  return { workflowId: def.workflowId, nodeCount: def.nodes.length };
}
