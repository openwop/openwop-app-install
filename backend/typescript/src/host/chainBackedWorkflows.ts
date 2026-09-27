/**
 * Chain-backed workflows (ADR 0472 Phase 1) — the SANCTIONED replacement for the
 * deprecated `builtinWorkflows` seam.
 *
 * A feature that needs a workflow to be **runnable by a stable id on every
 * instance** (restart/replay-safe) — an infra workflow an MCP mount, a scheduler
 * job, or an agent tool ignites by a fixed id — registers it HERE, derived from a
 * chain pack, instead of hand-coding a `WorkflowDefinition` in
 * `BackendFeature.builtinWorkflows`.
 *
 * The builtin conflated two jobs; this splits them cleanly:
 *   1. resolve-by-id on every instance  → THIS registry (a `host/index.ts` source-A
 *      resolver), keyed on the STABLE chainId (deterministic ⇒ replay/`:fork` safe).
 *   2. reachable/editable in `/builder` + the `/` picker → satisfied ALREADY by the
 *      chain being loaded (the chain gallery lists chains as instantiable templates;
 *      `from-chain` mints a tenant-owned editable copy). No code-pinned def is ever
 *      needed for reachability. `hostOwned` additionally records host-owned ownership
 *      so the expanded definition ALSO appears in a tenant's ownership index.
 *
 * THE GUARDRAIL: this API accepts ONLY a `chainId` — never a raw `WorkflowDefinition`.
 * A code-pinned, UI-unreachable definition is therefore not expressible here; the
 * chain registry stays the single source of truth. (ADR 0472; chains-or-stacks
 * doctrine — CLAUDE.md § "Workflows — never hard-code".)
 *
 * This is a CORE registry features write INTO (the same ADR 0001 inversion as
 * `registerToggleDefault` / `registerFeatureSurface`): core never imports
 * `features/`; features push their chain-backed workflows here at boot.
 */

import { getChain, expandChain } from './workflowChainPackLoader.js';
import { recordOwnership } from './workflowOwnership.js';
import { createLogger } from '../observability/logger.js';
import type { WorkflowDefinition } from '../executor/types.js';

const log = createLogger('host.chainBackedWorkflows');

/** The resolve-by-id registry (chainId → expanded, stable-id definition). */
const registry = new Map<string, WorkflowDefinition>();

/** Every host-default `subChainRef → workflowId` bind, recorded at build time keyed by
 *  parent chainId (overwritten per rebuild, so repeat builds stay idempotent). A parent
 *  can legitimately build/register BEFORE its child sibling registers, so bind targets
 *  cannot be checked eagerly — `validateChainBackedSubChainBinds` sweeps them once boot
 *  registration completes. */
const subChainBinds = new Map<string, ReadonlyArray<{ nodeId: string; childId: string }>>();

export interface ChainBackedWorkflowOptions {
  /** Optional per-feature post-processor applied to the expanded definition before
   *  registration (e.g. app-builder's output-role / model-policy / SSoT-catalog
   *  binding). Runs AFTER the generic expand + stable-id + param-name restore, so a
   *  feature customizes without re-implementing the chain-expansion plumbing. */
  postProcess?: (def: WorkflowDefinition) => void;
}

/**
 * Expand a loaded chain into a stable-id `WorkflowDefinition` and register it for
 * resolve-by-id on this instance. Returns the definition (also cached in the
 * registry). Deterministic: `workflowId === chainId`, so a run stamped with the id
 * re-resolves identically on replay/`:fork`.
 *
 * Generic steps (mirrors the app-builder `buildChainWorkflowDefinition` precedent
 * this generalizes):
 *   1. `expandChain({ deferred: true })` — materialize `{{params.*}}` as top-level
 *      `variables[]` so the workflow stays per-run configurable.
 *   2. stable id: `def.workflowId = chainId`.
 *   3. restore launch-contract param names — deferred materialization prefixes each
 *      param (`<chain>_<expansionId>_<name>`); restore the bare `<name>` everywhere
 *      it is declared or read, so a run passes inputs by the launch-contract name.
 *
 * @throws Error when `chainId` is not loaded (a missing pack is a boot-time defect).
 */
export function buildChainBackedDefinition(
  chainId: string,
  opts: ChainBackedWorkflowOptions = {},
): WorkflowDefinition {
  const entry = getChain(chainId);
  if (!entry) throw new Error(`chain '${chainId}' not loaded — cannot register a chain-backed workflow`);
  const def = expandChain(entry.chain, { deferred: true });
  def.workflowId = chainId;

  // Restore launch-contract param names (un-prefix the deferred-materialized names).
  // Grade-trio fix: a bare `endsWith('_<param>')` collides when one param is a
  // suffix of another (`count` also matches `<pfx>_retry_count`, renaming BOTH to
  // `count`). Match params LONGEST-FIRST and consume each materialized variable
  // exactly once, so `retry_count` claims its variable before `count` looks.
  const props = (entry.chain.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  const required = new Set((entry.chain.parameters as { required?: string[] }).required ?? []);
  const consumed = new Set<string>();
  /** Every variable this loop MOVED: materialized name → the restored bare name. */
  const renamed = new Map<string, string>();
  for (const param of Object.keys(props).sort((a, b) => b.length - a.length)) {
    for (const v of def.variables ?? []) {
      if (consumed.has(v.name) || !v.name.endsWith(`_${param}`)) continue;
      const materialized = v.name;
      v.name = param;
      consumed.add(param);
      renamed.set(materialized, param);
      if (required.has(param)) v.required = true;
      for (const node of def.nodes) {
        for (const [port, pv] of Object.entries(node.inputs ?? {})) {
          const val = pv as { type?: unknown; variableName?: unknown };
          if (val && val.type === 'variable' && val.variableName === materialized) {
            (node.inputs as Record<string, unknown>)[port] = { type: 'variable', variableName: param };
          }
        }
      }
    }
  }

  // PODWF-1 (ADR 0603 §2) — the rename above moved `variables[]` and every node
  // input, and left `metadata.deferredParameterAliases` (RFC 0124 G1 — bare param
  // name → materialized variable name) pointing at the PRE-rename names. That map is
  // what `deferredConfigurableInputs` translates a run's `configurable` overlay
  // through, so `POST /v1/runs { configurable: { episodeId: 'ep_A' } }` wrote the key
  // `podcasts_generate_<hash>_episodeId` — which NO declaration carries — and
  // `seedRunVariables` dropped it. FAIL-OPEN, not fail-closed: `configurableSchema`
  // is keyed by the BARE name so validation passes (no 400), the run starts, every
  // node reads `undefined`, and the failure surfaces deep inside a node with an error
  // that never names the parameter. MEASURED at 138/138 loaded chains carrying
  // deferred params — the loader's own output was correct in all 138; this lane
  // broke every one.
  //
  // MERGE the moved values through the rename map. NEVER replace the map: a
  // `metadata = { ...src.metadata }` copy (the shape ten lines away in
  // `registerMcpProjectionWorkflows`) DELETES the aliases for params this loop did
  // not move, trading one silent no-op for another. An entry whose value was not
  // renamed is left exactly as it was — this loop does not invent a mapping it did
  // not make.
  const aliases = def.metadata?.deferredParameterAliases;
  if (renamed.size > 0 && aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
    const map = aliases as Record<string, string>;
    for (const [bare, varName] of Object.entries(map)) {
      const moved = renamed.get(varName);
      if (moved !== undefined) map[bare] = moved;
    }
  }

  // RFC 0133 §1.2 — host-default sub-chain binding. A portable chain references a
  // child via `config.subChainRef` (the manifest FORBIDS a pinned `config.workflowId`
  // in the pack). At HOST-DEFAULT expansion we bind each ref to the SHARED same-id
  // sibling workflow (registered chain-backed independently), reproducing the
  // pre-migration builtin's exact dispatch target and keeping ONE copy of the child.
  // (TENANT `from-chain` instantiation is a DIFFERENT path: `coRegisterSubChains`
  // mints a per-tenant editable child copy — the pin lives in the host rewrite, never
  // in the portable pack, so the "a chain never pins a host workflow id" invariant
  // holds on both.) A sibling `ref` string IS the child's `chainId`; resolve through
  // the chain's declared `subChains[]` so an undeclared ref is a soft-logged pack
  // defect, never a silent runtime dangle.
  const refToChildId = new Map<string, string>();
  for (const s of entry.chain.subChains ?? []) {
    const refChainId = typeof s.ref === 'string' ? s.ref : s.ref.chainId;
    refToChildId.set(refChainId, refChainId);
  }
  const binds: Array<{ nodeId: string; childId: string }> = [];
  for (const node of def.nodes) {
    const cfg = node.config as Record<string, unknown> | undefined;
    const ref = cfg && typeof cfg.subChainRef === 'string' ? (cfg.subChainRef as string) : undefined;
    if (!cfg || !ref) continue;
    const childId = refToChildId.get(ref);
    if (!childId) {
      log.warn('chain_backed_subchainref_undeclared', { chainId, nodeId: node.nodeId, ref });
      continue;
    }
    delete cfg.subChainRef;
    cfg.workflowId = childId;
    binds.push({ nodeId: node.nodeId, childId });
  }
  subChainBinds.set(chainId, binds);

  opts.postProcess?.(def);
  return def;
}

/**
 * Register a chain-backed workflow for resolve-by-id at boot. `chainId`-ONLY — the
 * guardrail against reopening the code-pinned-def anti-pattern. Idempotent by id.
 * When `hostOwned` is set, ALSO records host-owned ownership under `ownerTenant`
 * (default the host-system tenant) so the definition appears in that tenant's
 * `/builder` ownership index in addition to the chain gallery.
 *
 * Fails LOUD in the log but SOFT at boot (the `features/index.ts` loop is unguarded;
 * a rethrow would abort the whole backend over one chain-pack drift — the
 * proportionate blast radius is "this feature's infra workflow absent", never "no
 * app"). Mirrors the app-builder registration adapter's grade-pass posture.
 */
export function registerChainBackedWorkflow(
  chainId: string,
  opts: ChainBackedWorkflowOptions & { hostOwned?: { ownerTenant: string; name?: string } } = {},
): void {
  try {
    const def = buildChainBackedDefinition(chainId, opts);
    registry.set(def.workflowId, def);
    if (opts.hostOwned) {
      void recordOwnership(opts.hostOwned.ownerTenant, def.workflowId, {
        name: opts.hostOwned.name ?? chainId,
        nodeCount: def.nodes.length,
      }).catch((err) =>
        log.error('chain_backed_ownership_failed', {
          chainId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  } catch (err) {
    log.error('chain_backed_registration_failed', {
      chainId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * CBW-1 — post-boot sweep: every host-default `subChainRef → workflowId` bind whose
 * PARENT registered must point at a child that is ALSO registered same-id, else the
 * parent's dispatch node carries a dangling id (a declared-but-unregistered sibling,
 * or an external `{packName, chainId}` ref this host never registered). Loud in the
 * log, soft at boot (same proportionate posture as registration: the blast radius is
 * "this workflow's child dispatch fails", never "no app"). Returns the dangling binds
 * so the boot caller/tests can assert on them. Parents that were built but never
 * registered (probes, tests) are skipped — their binds are not live dispatch surface.
 */
export function validateChainBackedSubChainBinds(): Array<{ parentId: string; nodeId: string; childId: string }> {
  const dangling: Array<{ parentId: string; nodeId: string; childId: string }> = [];
  for (const [parentId, binds] of subChainBinds) {
    if (!registry.has(parentId)) continue;
    for (const b of binds) {
      if (registry.has(b.childId)) continue;
      dangling.push({ parentId, nodeId: b.nodeId, childId: b.childId });
      log.error('chain_backed_subchain_target_unregistered', {
        parentId,
        nodeId: b.nodeId,
        childId: b.childId,
      });
    }
  }
  return dangling;
}

/** Resolve a chain-backed workflow by its stable id (a `host/index.ts` catalog
 *  source-A resolver), or undefined. */
export function getChainBackedWorkflow(workflowId: string): WorkflowDefinition | undefined {
  return registry.get(workflowId);
}

/** All registered chain-backed workflows (diagnostics / catalog listing / the MCP
 *  mount enumeration that used to read `listBuiltinWorkflows()`). */
export function listChainBackedWorkflows(): readonly WorkflowDefinition[] {
  return [...registry.values()];
}

/** Test seam — clear the registry between suites. */
export function _resetChainBackedWorkflowsForTest(): void {
  registry.clear();
  subChainBinds.clear();
}
