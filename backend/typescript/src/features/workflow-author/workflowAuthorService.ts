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
import { validateWorkflowDefinition, findWorkflowCycleError } from '../../host/workflowDefinitionValidation.js';
import { assertNoDisabledPacks } from '../../host/packEnablement.js';
import { registerWorkflowDurable, getRegisteredWorkflowAsync, listRegisteredWorkflows } from '../../host/workflowsRegistry.js';
import { recordRevision } from '../../host/workflowRevisions.js';
import { workflowRoomLive } from '../../host/collab/workflowCollabResource.js';
import { lifecycleOf, withHostLifecycle, catalogVisible } from '../../host/workflowLifecycle.js';
import { preserveDroppedFields, type PreservableField } from '../../host/preserveDroppedFields.js';
import { transientCapReached, transientCapValue, transientCapMessage } from '../../host/workflowComposeTool.js';
import {
  getOwned,
  listOwned,
  recordOwnership,
  isBuiltinWorkflowId,
  isAuthoredByOtherTenant,
  authoredWorkflowIds,
} from '../../host/workflowOwnership.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('workflow-author');

/** ADR 0596 — the HOST-OWNED provenance token. One constant, stamped on the
 *  definition AND the ownership row from the single write choke below, so the
 *  two can never disagree and a model can never author its own attribution. */
const AUTHORED_VIA = 'workflow-author';

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
 *  can't run (missing host surfaces), whose schema couldn't be inlined, or —
 *  ADR 0194 Phase 3 — from packs the caller's workspace disabled (the same
 *  `host/packVisibility` seam the palette uses, so the AI author can never plan
 *  a node the builder palette hides). */
export function buildAuthoringCatalog(opts?: { disabledPacks?: Set<string> }): AuthoringCatalog {
  const disabled = opts?.disabledPacks ?? new Set<string>();
  const catalog = buildNodeCatalog();
  const nodes: AuthorCatalogNode[] = [];
  const excluded: Array<{ typeId: string; reason: string }> = [];
  for (const n of catalog) {
    if (n.packName && disabled.has(n.packName)) {
      excluded.push({ typeId: n.typeId, reason: 'pack disabled in this workspace' });
      continue;
    }
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
  // ADR 0596 (`WFAWF-9`) — acyclicity, at BOTH authoring doors. The system
  // prompt has always told the model "the graph MUST be ACYCLIC" and nothing
  // checked it, so `validate` affirmatively certified an unrunnable graph:
  // `{ ok: true }`, then `cycle_detected` at dispatch, long after the model told
  // the user it was done. Same predicate as `persistAuthoredWorkflow` — one
  // helper, two call sites, never a second copy of the rule.
  const cycle = findWorkflowCycleError(def);
  if (cycle) {
    return {
      ok: false,
      errors: [`${cycle}. A WorkflowDefinition MUST be acyclic — remove the edge that closes the loop.`],
    };
  }
  return { ok: true, errors: [] };
}

/** A compact registered-workflow index entry — id + node count + authoring
 *  metadata. The shape chat and the meta-workflow's `get` node both read. */
export interface WorkflowIndexEntry {
  workflowId: string;
  nodeCount: number;
  name?: string;
  description?: string;
}

/**
 * Validate AND persist an authored candidate through the shared registration
 * path, tenant-scoped (ADR 0163 ownership layer). Throws `OpenwopError` (400) on
 * any structural / capability / closed-world violation — so an invalid graph can
 * never be registered.
 *
 * Ownership guard (CHAT-FIRST-PORT-AUDIT B1 / review HIGH-2): the authoring WRITE
 * lane must honor the SAME tenant isolation the POST /v1/host/openwop-app/workflows
 * route enforces (`isWriteProtected`). A tenant may create a fresh id or overwrite
 * its OWN workflow, but never overwrite a BUILT-IN host definition or another
 * tenant's authored workflow (a global-by-id registry write would otherwise poison
 * every future run + `:fork` of that id for all tenants). On success we
 * `recordOwnership` exactly as the route does, so the scoped list + the IDOR read
 * guard reflect the authored workflow.
 */
export async function persistAuthoredWorkflow(
  raw: unknown,
  opts: {
    tenantId: string;
    /**
     * ADR 0595 §Correction 1 — the ADR 0524 Phase E0 field DECLARATION, reached
     * from this lane. A caller that declares it models a field is telling the
     * host that omitting it is a DELETION, so the whole-set guard stands down
     * for that field alone.
     *
     * This is what makes the guard's exit REACHABLE here. `preserveDroppedFields`
     * is only safe because "explicitly cleared" is representable, and for node
     * `compensation` it is NOT: RFC 0151 §B is a closed block with `nodeTypeId`
     * REQUIRED, so `compensation:{}` is a 400 and `compensation:null` normalizes
     * to `undefined` — indistinguishable from omission by the time any merge
     * sees it. Without a declaration the field would be permanently
     * UNDELETABLE on this lane (a gate with no exit), which is verbatim the
     * forbidden state `preserveDroppedFields`'s docblock names.
     *
     * The REST lane reaches the same seam through the `x-openwop-field-contract`
     * header; this is the agent-lane equivalent, and it uses the SAME parser and
     * the SAME predicate — one owner, two call sites, never a second rule.
     */
    declaredFields?: ReadonlySet<PreservableField>;
  },
): Promise<{ workflowId: string; nodeCount: number; preservedFields?: PreservableField[] }> {
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
  // ADR 0596 (`WFAWF-9`) — the WRITE door's half of the acyclicity gate. A gate
  // on `validate` alone would be a gate on the CREATION lane and not on the USE
  // lane: `persist` is separately callable (the chat tool, the surface, the node)
  // and a model that skips `validate` — or revises after it — would otherwise
  // still reach durable state with a graph that can only ever `cycle_detected`.
  const cycleOnWrite = findWorkflowCycleError(def);
  if (cycleOnWrite) {
    throw new OpenwopError(
      'validation_error',
      `${cycleOnWrite}. A WorkflowDefinition MUST be acyclic — remove the edge that closes the loop.`,
      400,
      { workflowId: def.workflowId, reason: 'cycle_detected' },
    );
  }
  const { tenantId } = opts;
  // ADR 0595 §Correction 4 — the ADR 0194 P3 tenant curation, on the MODEL door.
  // The closed-world check above resolves against the HOST-GLOBAL catalog, so it
  // says "legal" for a node from a pack this workspace disabled. The AI author's
  // MENU is already curated (`buildAuthoringCatalog` takes `disabledPacks`),
  // which hides the gap while the model only uses what it was shown — and it
  // bites the moment it names a typeId from a prior turn, from
  // `openwop:schema.lookup`, or from its own memory. The REST create, revision
  // restore, from-chain and collab-derive lanes have all called this since ADR
  // 0194 P3 / ADR 0481; this door and its `propose` sibling did not, so tenant
  // curation was enforced on the doors a HUMAN uses and skipped on the doors a
  // MODEL uses. Same choke helper, never a second copy of the rule.
  await assertNoDisabledPacks(def, tenantId);
  // Overwrite guard — skipped when the tenant already OWNS this id (self-save /
  // autosave). A fresh, un-registered id passes both checks and is created.
  const ownsIt = Boolean(await getOwned(tenantId, def.workflowId));
  if (!ownsIt) {
    if (await isBuiltinWorkflowId(def.workflowId)) {
      throw new OpenwopError(
        'conflict',
        `Workflow id '${def.workflowId}' is a built-in host workflow and cannot be overwritten. Author it under a new workflowId.`,
        409,
        { workflowId: def.workflowId, reason: 'builtin_workflow' },
      );
    }
    if (await isAuthoredByOtherTenant(tenantId, def.workflowId)) {
      throw new OpenwopError(
        'conflict',
        `Workflow id '${def.workflowId}' is owned by another workspace and cannot be overwritten. Author it under a new workflowId.`,
        409,
        { workflowId: def.workflowId, reason: 'owned_by_other_tenant' },
      );
    }
  }
  // ADR 0481 (code-review H3) — D2: while a collab room lives, the room is
  // the head's ONLY writer. Typed refusal the agent can relay honestly.
  if (await workflowRoomLive(def.workflowId)) {
    throw new OpenwopError('conflict', 'This workflow is in a live collaboration session; ask the collaborators, or persist after the session ends.', 409, { workflowId: def.workflowId, reason: 'workflow_room_live' });
  }
  // ── ADR 0595 — the write, in the only order that fails closed. ─────────────
  //
  // The prior head, read ONCE and reused for both guards below. Owner-gated for
  // the same reason `routes/workflows.ts` gates its removed-node disclosure: the
  // registry is global by id, so reading it for a non-owner would be an
  // existence oracle. A non-owner cannot reach here anyway (the guards above),
  // so this is defence in depth, not the gate.
  const previous = ownsIt ? await getRegisteredWorkflowAsync(def.workflowId) : null;

  // 1. PRESERVE (ADR 0524, reversing its §Exemptions carve-out for this lane —
  //    see ADR 0595 §"The exemption this reverses"). By DEFAULT no
  //    `declaredFields`: the authoring brain's structured-output schema provably
  //    cannot express these fields, so its omission is a capability signal,
  //    never a deletion. The whole-set discriminator still stands down for a
  //    PARTIAL edit, which is what makes "the author intentionally replaced
  //    them" survivable — and an EXPLICIT declaration (ADR 0595 §Correction 1)
  //    is what makes a genuine deletion expressible at all on this lane.
  const preservation = preserveDroppedFields(def, previous, opts.declaredFields);

  // 2. STAMP the lifecycle server-side (ADR 0369 §5). Two rules, both load-bearing:
  //    - The model NEVER writes lifecycle: `withHostLifecycle` discards whatever
  //      `metadata.lifecycle` the candidate carried, so a model cannot mint a
  //      born-archived workflow and be told it succeeded.
  //    - Stamp `transient` ON CREATE ONLY. ADR 0369 §5 says drafts are transient
  //      "at creation" and that SAVE = PROMOTE; applying it to every write would
  //      DEMOTE an already-promoted workflow the moment its owner asked the AI
  //      to tweak it — pulling a saved workflow out of the `/` picker as a side
  //      effect of an edit. A revise inherits the head's lifecycle verbatim.
  const priorLc = previous ? lifecycleOf(previous) : null;
  const defToPersist = withHostLifecycle(preservation.definition, priorLc
    ? priorLc
    : { transient: true, generatedBy: 'workflow-author' });

  // 2b. The ADR 0369 OQ4 abuse bound, on CREATE only. Its sibling `propose` has
  //     been capped since ADR 0473 while this lane was unbounded — so the
  //     Architect, which picks between the two doors from the user's PHRASING,
  //     could mint unlimited durable workflows simply by saying "persist". Now
  //     BOTH doors draw on ONE budget (`transientCapReached`, imported rather
  //     than re-derived), so alternating doors cannot double the ceiling.
  //     Overwriting a draft the tenant ALREADY owns adds nothing to the budget
  //     and is never refused — a cap that blocked editing what it capped would
  //     be a gate with no exit.
  if (!ownsIt && (await transientCapReached(tenantId))) {
    throw new OpenwopError(
      'conflict',
      // ADR 0595 §Correction 7 — the ONE message, from the same module as the
      // counter. The hand-written copy that lived here named "AI-authored
      // drafts" while the counter counts EVERY live transient the tenant owns
      // (agent proposals and recorded tours included), and led with "Save
      // (promote)", which 409s for exactly the un-run drafts consuming the
      // budget. A refusal that names the wrong population and the wrong remedy
      // is a dead end wearing the costume of guidance.
      transientCapMessage(),
      409,
      { workflowId: def.workflowId, reason: 'transient_workflow_cap', cap: transientCapValue() },
    );
  }

  // 2c. STAMP PROVENANCE SERVER-SIDE (ADR 0596 §5, `WFAC-9` / `WFAU-2` /
  //     `WFAWF-2`). Provenance used to be stamped ONLY inside the pack's `draft`
  //     node, which is two defects at once:
  //       - LANE-DEPENDENT. The CHAT lane authors in the agent loop and calls
  //         `persist` directly, so a workflow written entirely by a model
  //         carried NO provenance at all.
  //       - FORGEABLE. It was stamped onto the model-controlled candidate, so
  //         `authoredVia` was whatever the model last said it was.
  //     The host now OWNS `authoredVia` on every door — the same shape
  //     `withHostLifecycle` uses for lifecycle, and for the same reason. The
  //     descriptive fields the RUN knows and the service does not (`intent`,
  //     `model`, `attempts`) are preserved as-is: they are testimony, not
  //     authority, and nothing reads them as authority.
  //     Deliberately NO timestamp here — the definition is content-addressed by
  //     `recordRevision`, so a clock value inside it would mint a spurious
  //     revision on every re-persist of identical content.
  const priorAuthoring = defToPersist.metadata?.authoring;
  defToPersist.metadata = {
    ...(defToPersist.metadata ?? {}),
    authoring: {
      ...(priorAuthoring && typeof priorAuthoring === 'object' && !Array.isArray(priorAuthoring)
        ? priorAuthoring as Record<string, unknown>
        : {}),
      authoredVia: AUTHORED_VIA,
    },
  };

  const lc = lifecycleOf(defToPersist);
  const name = typeof defToPersist.metadata?.name === 'string' ? defToPersist.metadata.name : undefined;

  // 3. OWNERSHIP FIRST, then the definition. The old order registered the def,
  //    AWAITED `recordRevision`, then recorded ownership — so a throw in the
  //    middle left a definition permanently REGISTERED and permanently UNOWNED.
  //    `listAuthoredWorkflows` classifies an unowned registered def as a host
  //    BUILT-IN (`:isBuiltin` below), so that state is readable by EVERY tenant
  //    and overwritable by NONE (its own author then 409s on `isBuiltinWorkflowId`).
  //    Ownership-first inverts the failure: a lost def write leaves an ownership
  //    row pointing at nothing — invisible (the registry listing never sees it),
  //    harmless, and re-writable by its owner on retry.
  await recordOwnership(tenantId, def.workflowId, {
    ...(name !== undefined ? { name } : {}),
    // ADR 0596 — denormalized onto the row the scoped list actually projects
    // from; sticky there, so a later builder save cannot erase it.
    authoredVia: AUTHORED_VIA,
    nodeCount: defToPersist.nodes.length,
    ...(lc.transient !== undefined ? { transient: lc.transient } : {}),
    ...(lc.archivedAt !== undefined ? { archivedAt: lc.archivedAt } : {}),
  });
  // 4. AWAIT the durable definition write. `registerWorkflow` fires the kv write
  //    fire-and-forget, so a lost write let this lane return 201 over a
  //    definition no other instance can resolve — while the tool had already
  //    told the user "it is open in the builder". The sibling compose lane fixed
  //    exactly this (`host/workflowComposeTool.ts` `registerTransientDraft`,
  //    ADR 0473 D5); this matches that shape rather than inventing a second one.
  await registerWorkflowDurable(defToPersist);
  // 5. ADR 0474 — append the content revision beside ownership (history).
  //    MUST be `defToPersist`: the revision store is content-addressed, so
  //    recording the pre-merge `def` would hash content that was never the head.
  await recordRevision(tenantId, defToPersist);
  log.info('workflow_author_persisted', {
    workflowId: def.workflowId,
    nodeCount: defToPersist.nodes.length,
    tenantId,
    ...(preservation.preserved.length > 0 ? { preservedFields: preservation.preserved } : {}),
  });
  return {
    workflowId: def.workflowId,
    nodeCount: defToPersist.nodes.length,
    // NOT SILENT (ADR 0524 §5): a merge nobody can see is a silent success
    // wearing the costume of a fix. The tool relays this to the model, which
    // relays it to the user.
    ...(preservation.preserved.length > 0 ? { preservedFields: preservation.preserved } : {}),
  };
}

/**
 * Read an EXISTING registered workflow BY ID, tenant-scoped (ADR 0163 IDOR read
 * guard — the same posture as `GET /v1/workflows/{id}` / `isForeignOwned`).
 * Returns the definition iff `tenantId` OWNS it or it is a BUILT-IN host/template
 * def; a workflow authored by ANOTHER tenant is an indistinguishable miss
 * (`{ found: false }`, the exact shape of an unknown id — no existence oracle).
 */
export async function readAuthoredWorkflow(
  workflowId: string,
  opts: { tenantId: string },
): Promise<{ found: true; definition: WorkflowDefinition } | { found: false }> {
  const def = await getRegisteredWorkflowAsync(workflowId);
  if (!def) return { found: false };
  if (await getOwned(opts.tenantId, workflowId)) return { found: true, definition: def };
  // Not owned by the caller: readable only if it is NOT another tenant's
  // authored workflow (i.e. it is a built-in / tenant-unowned host def).
  if (await isAuthoredByOtherTenant(opts.tenantId, workflowId)) return { found: false };
  return { found: true, definition: def };
}

/**
 * The registered-workflow index scoped to `tenantId` (ADR 0163): the tenant's
 * OWN authored workflows + BUILT-IN host/template defs, and NEVER another
 * tenant's authored workflow (which the unscoped registry listing would leak).
 */
export async function listAuthoredWorkflows(opts: { tenantId: string }): Promise<WorkflowIndexEntry[]> {
  const owned = new Set((await listOwned(opts.tenantId)).map((r) => r.workflowId));
  const authored = await authoredWorkflowIds();
  const out: WorkflowIndexEntry[] = [];
  // ADR 0595 — authored definitions are now born TRANSIENT (ADR 0369 §5), which
  // `catalogVisible` hides by default. Ask for them and re-apply the filter per
  // row below, so a tenant keeps seeing its OWN drafts while another tenant's —
  // and the host's — stay hidden. This mirrors the decision the scoped REST list
  // already made (`routes/workflows.ts`: "Transient DRAFTS stay VISIBLE here —
  // this is the owner's own scoped list"). Without it the Architect could not
  // list the workflow it had just authored, breaking read-before-write on the
  // very next turn — a fix that reintroduces the family it closes.
  for (const w of listRegisteredWorkflows({ includeTransient: true })) {
    const isOwn = owned.has(w.workflowId);
    const isBuiltin = !authored.has(w.workflowId); // registered + no tenant owns it
    if (!isOwn && !isBuiltin) continue; // another tenant's authored workflow — hide
    if (!isOwn && !catalogVisible(w)) continue; // a host/foreign draft stays hidden
    const name = typeof w.metadata?.name === 'string' ? w.metadata.name : undefined;
    const description = typeof w.metadata?.description === 'string' ? w.metadata.description : undefined;
    out.push({
      workflowId: w.workflowId,
      nodeCount: w.nodes.length,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    });
  }
  return out;
}
