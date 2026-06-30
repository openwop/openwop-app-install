/**
 * Workflow-chain pack loader + expansion — RFC 0013 (ADR 0152).
 *
 * Loads `kind:"workflow-chain"` packs (the real-work workflows published at
 * packs.openwop.dev, vendored under `examples/workflow-chain-packs/`), and
 * expands a chain into a concrete `WorkflowDefinition` per RFC 0013 §"Expansion
 * semantics". Peer to `connectionPackLoader` / `promptPackLoader` /
 * `artifactTypePackLoader` (this file deliberately mirrors the connection loader).
 *
 * ── Why a separate loader (not the node `tarballLoader`) ──
 * A chain pack carries DAG fragments, not executable node modules. Its fragment
 * nodes reference ALREADY-PUBLISHED `core.*` / vendor node typeIds (the RFC 0013
 * portability invariant), so a chain is host-portable. The node loader handles
 * `kind:"node"`; this handles `kind:"workflow-chain"`.
 *
 * ── Expansion is FROZEN + deterministic (ADR 0152 R2) ──
 * `expandChain(chain, params)` derives a deterministic `expansionId` from a hash
 * of `(chainId, version, canonical(params))` — no clock, no randomness — so the
 * node-id rewrite and the resulting `WorkflowDefinition` are byte-stable. The
 * caller persists the expanded definition through the EXISTING builder registry
 * (`registerWorkflow`, ADR 0152 R3) — no new pinned catalog source. A `:fork`
 * then re-resolves the SAME frozen definition (ADR 0031 determinism).
 *
 * ── Trust (R7) ──
 * In-tree vendored packs are trusted source (same posture as the vendored
 * connection/node packs — no signature check here). Ed25519 signature
 * verification is the REGISTRY-FETCH path (a later enhancement), not this
 * in-tree loader.
 *
 * @see docs/adr/0150-workflow-chain-pack-loader.md
 * @see ../../../schemas/workflow-chain-pack-manifest.schema.json (RFC 0013)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { resolveDefaultPackDir } from '../packs/registryInstaller.js';
import { locateRepoSchemasDir } from './_repoPath.js';
import { validateWorkflowDefinition } from './workflowDefinitionValidation.js';
import type { EdgeDef, WorkflowDefinition } from '../executor/types.js';

const log = createLogger('host.workflowChainPackLoader');
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = locateRepoSchemasDir(__dirname, 'workflow-chain-pack-manifest.schema.json');

// ── manifest shapes (the subset we consume; the schema is the authority) ──

interface FragmentNode {
  id: string;
  typeId: string;
  name?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}
interface FragmentEdge {
  from: string; // "nodeId[.outputPort]"
  to: string; // "nodeId[.inputPort]"
  condition?: string;
}
export interface WorkflowChain {
  chainId: string;
  version: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema for params
  dag: { nodes: FragmentNode[]; edges?: FragmentEdge[] };
  outputs?: Record<string, { type: string; description: string }>;
  capabilities?: string[];
}
interface ChainPackManifest {
  name: string;
  version: string;
  kind: string;
  chains: WorkflowChain[];
}

export interface ChainPackLoadResult {
  packName: string;
  packVersion: string;
  chainIds: string[];
}
export interface ChainPackLoadError {
  pack: string;
  code: string;
  message: string;
}
export interface ChainPackLoadOutcome {
  installed: ChainPackLoadResult[];
  errors: ChainPackLoadError[];
}

// ── schema validator (lazy singleton, mirrors connectionPackLoader) ──
let _validator: ValidateFunction | undefined;
function manifestValidator(): ValidateFunction {
  if (_validator) return _validator;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, 'workflow-chain-pack-manifest.schema.json'), 'utf8'),
  );
  _validator = ajv.compile(schema);
  return _validator;
}

// ── the in-process registry of loaded chains (chainId → {packName, chain}) ──
const CHAINS = new Map<string, { packName: string; chain: WorkflowChain }>();

/** Default roots: in-tree `examples/workflow-chain-packs/`, the registry-install
 *  dir (`OPENWOP_PACK_DIR` — ADR 0163 Phase 7: a `kind:"workflow-chain"` pack named
 *  in `OPENWOP_INSTALL_PACKS` is fetched + Ed25519/SRI-verified from
 *  packs.openwop.dev at boot by `ensureRegistryPacksInstalled`, then loaded here as
 *  a template — same path node packs download by), + an operator override dir. The
 *  loader kind-filters, so non-workflow-chain packs in the install dir are ignored. */
export function defaultWorkflowChainPackRoots(): string[] {
  const repoRoot = dirname(SCHEMAS_DIR);
  return [
    join(repoRoot, 'examples', 'workflow-chain-packs'),
    resolveDefaultPackDir(),
    process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR ?? '',
  ].filter((p) => p.length > 0);
}

/** Discover + validate + register every `kind:"workflow-chain"` pack under `roots`.
 *  Collects errors (never throws on a bad pack — boot must not abort). */
export function loadWorkflowChainPacks(opts: { roots: string[] }): ChainPackLoadOutcome {
  const installed: ChainPackLoadResult[] = [];
  const errors: ChainPackLoadError[] = [];
  const validate = manifestValidator();

  for (const root of opts.roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const packFile = join(root, entry, 'pack.json');
      if (!existsSync(packFile) || !statSync(join(root, entry)).isDirectory()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(packFile, 'utf8'));
      } catch (e) {
        errors.push({ pack: entry, code: 'pack_manifest_unreadable', message: String(e) });
        continue;
      }
      if ((raw as { kind?: unknown }).kind !== 'workflow-chain') continue; // not ours
      if (!validate(raw)) {
        errors.push({
          pack: entry,
          code: 'workflow_chain_pack_manifest_invalid',
          message: JSON.stringify(validate.errors),
        });
        continue;
      }
      const manifest = raw as ChainPackManifest;
      const chainIds: string[] = [];
      for (const chain of manifest.chains) {
        // last-writer-wins is avoided: a duplicate chainId is an error (no silent shadow).
        if (CHAINS.has(chain.chainId)) {
          errors.push({
            pack: manifest.name,
            code: 'workflow_chain_id_conflict',
            message: `chainId ${chain.chainId} already registered`,
          });
          continue;
        }
        CHAINS.set(chain.chainId, { packName: manifest.name, chain });
        chainIds.push(chain.chainId);
      }
      installed.push({ packName: manifest.name, packVersion: manifest.version, chainIds });
    }
  }
  if (installed.length) {
    log.info('workflow_chain_packs_loaded', {
      packs: installed.length,
      chains: installed.reduce((n, p) => n + p.chainIds.length, 0),
    });
  }
  for (const e of errors) log.warn('workflow_chain_pack_rejected', { ...e });
  return { installed, errors };
}

/** Resolve a loaded chain by id (null = absent). */
export function getChain(chainId: string): { packName: string; chain: WorkflowChain } | null {
  return CHAINS.get(chainId) ?? null;
}

/** All loaded chains (UI/catalog listing). */
export function listChains(): ReadonlyArray<{ packName: string; chain: WorkflowChain }> {
  return [...CHAINS.values()];
}

/** Test seam: clear the in-process chain registry. */
export function _resetChainRegistryForTest(): void {
  CHAINS.clear();
}

/** Hot-reload the chain registry from the default roots (ADR 0163 follow-on —
 *  runtime pack install without restart). Clears + rescans so a freshly
 *  registry-installed `kind:"workflow-chain"` pack becomes listable/instantiable
 *  immediately, and a duplicate-chainId re-scan can't accumulate conflict errors.
 *  Returns the load outcome so the caller can surface what newly resolved. */
export function reloadWorkflowChainPacks(): ChainPackLoadOutcome {
  CHAINS.clear();
  return loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
}

// ── expansion (RFC 0013 §"Expansion semantics") ──

const PARAM_RE = /\{\{\s*params\.([a-zA-Z0-9_]+)\s*\}\}/g;

/** Stable, hash-derived expansion id (R2 — no clock/randomness). */
function deterministicExpansionId(chain: WorkflowChain, params: Record<string, unknown>): string {
  const canonical = JSON.stringify(params, Object.keys(params).sort());
  return createHash('sha256')
    .update(`${chain.chainId}@${chain.version}:${canonical}`)
    .digest('hex')
    .slice(0, 12);
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Recursively substitute `{{params.<name>}}` in string leaves of a value. */
function substitute(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return value.replace(PARAM_RE, (_m, name: string) => {
      const v = params[name];
      return v === undefined || v === null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, params));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, params)]),
    );
  }
  return value;
}

/** Apply the chain's `parameters` JSON-Schema defaults, then validate the merged
 *  params. Throws `chain_parameter_invalid` on a schema violation. */
function resolveParams(chain: WorkflowChain, input: Record<string, unknown>): Record<string, unknown> {
  const props = (chain.parameters as { properties?: Record<string, { default?: unknown }> }).properties ?? {};
  const merged: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(props)) {
    if (input[name] !== undefined) merged[name] = input[name];
    else if (spec.default !== undefined) merged[name] = spec.default;
  }
  for (const [k, v] of Object.entries(input)) if (!(k in merged)) merged[k] = v;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(chain.parameters as object);
  if (!validate(merged)) {
    throw new OpenwopError('validation_error', `chain_parameter_invalid: ${JSON.stringify(validate.errors)}`, 400);
  }
  return merged;
}

/** Options for expansion. `isTypeIdKnown` (when provided) enforces RFC 0013's
 *  `chain_unresolvable_typeid` — every fragment typeId must resolve on this host
 *  (R8). Omit it where typeId existence is checked elsewhere (e.g. at dispatch). */
export interface ExpandOptions {
  params?: Record<string, unknown>;
  isTypeIdKnown?: (typeId: string) => boolean;
}

/**
 * Expand a chain into a concrete, FROZEN `WorkflowDefinition` (RFC 0013 §expansion):
 * resolve+validate params → substitute `{{params.*}}` → deterministically rewrite
 * node ids → map fragment edges → mark the terminal node `primary` → validate the
 * result through the shared `validateWorkflowDefinition` (R8). Pure + deterministic:
 * same (chain, params) ⇒ byte-identical definition.
 */
export function expandChain(chain: WorkflowChain, opts: ExpandOptions = {}): WorkflowDefinition {
  const params = resolveParams(chain, opts.params ?? {});
  const expansionId = deterministicExpansionId(chain, params);
  const prefix = `${slug(chain.chainId)}_${expansionId}_`;
  const rewrite = (nodeId: string): string => `${prefix}${nodeId}`;
  // Parse "nodeId[.port]" → { node, port }.
  const parseRef = (ref: string): { node: string; port?: string } => {
    const dot = ref.indexOf('.');
    return dot === -1 ? { node: ref } : { node: ref.slice(0, dot), port: ref.slice(dot + 1) };
  };

  if (opts.isTypeIdKnown) {
    for (const n of chain.dag.nodes) {
      if (!opts.isTypeIdKnown(n.typeId)) {
        throw new OpenwopError('validation_error', `chain_unresolvable_typeid: ${n.typeId}`, 400);
      }
    }
  }

  const edges = chain.dag.edges ?? [];
  const hasOutgoing = new Set(edges.map((e) => parseRef(e.from).node));
  const terminalNodes = chain.dag.nodes.filter((n) => !hasOutgoing.has(n.id));
  const primaryNodeId = (terminalNodes[terminalNodes.length - 1] ?? chain.dag.nodes[chain.dag.nodes.length - 1])?.id;

  const nodes = chain.dag.nodes.map((n) => ({
    nodeId: rewrite(n.id),
    typeId: n.typeId,
    ...(n.config ? { config: substitute(n.config, params) as Record<string, unknown> } : {}),
    ...(n.inputs ? { inputs: substitute(n.inputs, params) as Record<string, unknown> } : {}),
    ...(n.id === primaryNodeId ? { outputRole: 'primary' as const } : {}),
  }));

  const mappedEdges: EdgeDef[] = edges.map((e, i) => {
    const from = parseRef(e.from);
    const to = parseRef(e.to);
    return {
      edgeId: `e${i + 1}`,
      sourceNodeId: rewrite(from.node),
      ...(from.port ? { sourceOutput: from.port } : {}),
      targetNodeId: rewrite(to.node),
      ...(to.port ? { targetInput: to.port } : {}),
    };
  });

  const definition: WorkflowDefinition = {
    workflowId: `${chain.chainId}:${expansionId}`,
    nodes,
    edges: mappedEdges,
    metadata: {
      name: chain.label,
      purpose: chain.description,
      source: 'workflow-chain-pack',
      chainId: chain.chainId,
      chainVersion: chain.version,
      expansionId,
      params,
      ...(chain.capabilities ? { capabilities: chain.capabilities } : {}),
      ...(chain.outputs ? { outputs: chain.outputs } : {}),
    },
  };

  // R8 — the expanded graph is validated exactly like any authored workflow.
  return validateWorkflowDefinition(definition);
}
