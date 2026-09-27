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
 * ── Trust (R7 + ADR 0427) ──
 * In-tree vendored packs and the operator-override dir are trusted source
 * (same posture as the vendored connection/node packs — no signature check).
 * REGISTRY-INSTALLED packs (the `resolveDefaultPackDir()` root) are verified
 * against the ADR 0367 pinned keyring at LOAD time (bytes at rest are not
 * trusted state): with `OPENWOP_REQUIRE_CHAINPACK_SIGNATURES` set, an
 * unsigned/failed/revoked pack is REJECTED (fail closed, collected error —
 * boot never aborts); unset, it loads with a warn so operators can observe
 * before enforcing. The deploy that opens third-party executable challenges
 * MUST set the flag (the ADR 0420 P4 trigger).
 *
 * @see docs/adr/0152-workflow-chain-pack-loader.md
 * @see ../../../schemas/workflow-chain-pack-manifest.schema.json (RFC 0013 — v1-shaped + unsigned manifests)
 * @see ../../../schemas/v2/workflow-chain-pack-manifest.schema.json (RFC 0177 — v2-signed manifests; WHD-15)
 */

import { verifyInstalledPack } from '../packs/registryInstaller.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { resolveDefaultPackDir } from '../packs/registryInstaller.js';
import { loadPinnedKeyring, verifyPinned, type SigningRefs } from './packSignature.js';
import { locateRepoSchemasDir } from './_repoPath.js';
import { validateWorkflowDefinition } from './workflowDefinitionValidation.js';
import { canonicalize } from './auditChainService.js';
import { mapEdgeCondition, type WireEdgeCondition } from './edgeConditionMapping.js';
import { getPromptsHostConfig } from './promptHostConfig.js';
import { substituteTokensDeep } from './tokenSubstitution.js';
import { registerMintedTemplate, type PromptTemplate } from './promptStore.js';
import type { EdgeDef, WorkflowDefinition } from '../executor/types.js';
import type { CompensationPolicy } from './compensationUnwind.js';
import { isParkedPackDirName } from '../bootstrap/mountLocalPacks.js';
import { semverCompare } from '../util/semver.js';
// Alias the import: the esbuild bundle banner (see package.json `build`) injects its
// own top-level `import { createRequire } from 'module'`, and esbuild renames local
// identifiers BEFORE the raw banner text is prepended — so an unaliased `createRequire`
// import here produces a duplicate top-level declaration that fails to compile at
// container boot ("Identifier 'createRequire' has already been declared"). Aliasing
// keeps this file's binding distinct from the banner's. (Moved here with the resolver
// in ADR 0550 P2 — the hazard travels with the import, not with the file.)
import { createRequire as nodeCreateRequire } from 'node:module';
import { readFileSync as nodeReadFileSync } from 'node:fs';
import { dirname as nodeDirname, join as nodeJoin } from 'node:path';

/** The published `vendor.openwop.workflow-chain-sample` fixture pack.
 *
 * Lives HERE rather than in the route because the ADVERTISEMENT depends on it,
 * and `routes/workflowChainExpandSeam.ts` already imports this module — putting
 * it there and importing back would be a cycle. Cached; `null` when the
 * conformance package is absent, which is the NORMAL state of a production
 * image (`npm ci --omit=dev`), not an error. */
let chainSamplePackCache: ChainSamplePack | null | undefined;
export interface ChainSamplePack { name: string; version: string; chains: WorkflowChain[] }
export function loadChainSamplePack(): ChainSamplePack | null {
  if (chainSamplePackCache !== undefined) return chainSamplePackCache;
  try {
    const req = nodeCreateRequire(import.meta.url);
    const pkgJson = req.resolve('@openwop/openwop-conformance/package.json');
    const path = nodeJoin(nodeDirname(pkgJson), 'fixtures', 'pack-manifests', 'workflow-chain-sample.pack.json');
    chainSamplePackCache = JSON.parse(nodeReadFileSync(path, 'utf8')) as ChainSamplePack;
  } catch {
    chainSamplePackCache = null;
  }
  return chainSamplePackCache;
}

/** The ONE predicate behind the RFC 0013 host-expansion seam — consulted by the
 *  advertisement (`workflowChainPacksCapability`) and by the route registration
 *  (`registerWorkflowChainExpandSeamRoutes`) alike.
 *
 *  It is a function, not a copied expression, deliberately. ADR 0550 P2 shipped
 *  this predicate twice — once per call site — under a comment claiming the two
 *  "cannot disagree". Two copies of an expression are exactly the thing that
 *  drifts, and the defect being fixed here WAS a drift between advertising and
 *  serving. One function makes the claim structural.
 *
 *  Both arms matter. `OPENWOP_TEST_SEAM_ENABLED` keeps the witness seam out of
 *  production; the pack check keeps a host that cannot serve the fixture from
 *  claiming it can — the release image runs `npm ci --omit=dev`, and the
 *  conformance package is a devDependency. */
export function isChainExpansionSeamServable(): boolean {
  return process.env.OPENWOP_TEST_SEAM_ENABLED === 'true' && loadChainSamplePack() !== null;
}

const log = createLogger('host.workflowChainPackLoader');
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = locateRepoSchemasDir(__dirname, 'workflow-chain-pack-manifest.schema.json');

// ── manifest shapes (the subset we consume; the schema is the authority) ──

/** RFC 0157 §A — the fragment node's inverse action. A MIRROR of
 *  `workflow-definition.schema.json#/$defs/WorkflowNode/properties/compensation`
 *  (closed; `nodeTypeId` REQUIRED), so it is exactly `WorkflowNode['compensation']`
 *  and nothing host-private may be added: a chain-pack node carrying an extra key
 *  is rejected by the manifest schema before this host ever sees it. */
export type FragmentNodeCompensation = NonNullable<WorkflowDefinition['nodes'][number]['compensation']>;

interface FragmentNode {
  id: string;
  typeId: string;
  name?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  /** RFC 0157 §A — DESCRIPTIVE: it says what the inverse action is. Carried
   *  through expansion VERBATIM whether or not this host advertises
   *  `capabilities.compensation` (unlike the chain-level POLICY below, which
   *  asserts the host will act). */
  compensation?: FragmentNodeCompensation;
  /** RFC 0151 §B UQ4, mirrored per RFC 0157 — the author states this node's
   *  committed effect HAS NO INVERSE. Mutually exclusive with `compensation`
   *  (`chain_irreversible_with_compensation`); copied onto the expanded node. */
  irreversibleEffect?: boolean;
}
interface FragmentEdge {
  from: string; // "nodeId[.outputPort]"
  to: string; // "nodeId[.inputPort]"
  // The wire edge-condition shape (workflow-definition.schema.json §EdgeCondition,
  // RFC 0013 §edges "same shape as a top-level workflow edge") — what a chain
  // fragment carries after the 2026-07-03 safety-fix. Mapped to the host's
  // `EdgeDef.condition` at expansion time via the shared `mapEdgeCondition`
  // (edgeConditionMapping.ts — the one authority both ingest seams share).
  condition?: WireEdgeCondition;
  // Fan-in / error-routing rule for the target — mirrors `WorkflowEdge.triggerRule`
  // (RFC 0125, the same "mirror a WorkflowEdge field onto FragmentEdge" move as the
  // `condition` amendment). Carried VERBATIM onto the expanded WorkflowEdge at
  // expansion (RFC 0125 §"Expansion semantics" step 6 — expansion MUST preserve it,
  // else the scheduler never honors it). Unlike `condition` it needs no mapping: the
  // wire enum and `EdgeDef.triggerRule` are the identical string set. Absent ⇒
  // `all_success` (the executor's default) = today's behavior.
  triggerRule?: EdgeDef['triggerRule'];
}
/** RFC 0133 §1 — a child chain a parent composes. `ref` is a SIBLING chainId in
 *  the same pack, or an external `{packName, chainId, version}` published chain. A
 *  fragment node references it via `config.subChainRef` (never a hard-coded
 *  `config.workflowId`); `from-chain` co-expands + co-registers the child and
 *  rewrites the reference to the minted child workflow id. */
export type SubChainRef = { ref: string | { packName: string; chainId: string; version: string } };

/** RFC 0133 §2 — a run-PRODUCED variable: a value `producedBy` a node writes to
 *  the run bag that a downstream node reads via `{type:'variable',variableName}`.
 *  Distinct from author-time `parameters`; emitted into the expanded
 *  `WorkflowDefinition.variables[]` as run-scoped (name+type, NO defaultValue —
 *  the SR-1 at-rest guard). */
export interface ProducedVariable { name: string; producedBy: string; type: string; description?: string }

export interface WorkflowChain {
  chainId: string;
  version: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema for params
  dag: { nodes: FragmentNode[]; edges?: FragmentEdge[] };
  outputs?: Record<string, { type: string; description: string }>;
  capabilities?: string[];
  /** RFC 0133 §1 — child chains this chain composes (optional; absent ⇒ RFC 0013 behavior). */
  subChains?: SubChainRef[];
  /** RFC 0133 §2 — run-produced variables this chain's nodes write + read by name (optional). */
  producedVariables?: ProducedVariable[];
  /** RFC 0135 — composition-only fragment: default gallery/picker listings MUST omit it;
   *  every non-presentational behavior (load, resolve-by-id, expansion, from-chain,
   *  sub-chain composition) is unchanged. Presentational only, NEVER an authz boundary. */
  internal?: boolean;
  /** RFC 0157 §B — the chain-level compensation POLICY, a MIRROR of
   *  `compensation-policy.schema.json` (RFC 0151 §B; closed, `triggers` REQUIRED).
   *  It REQUESTS an unwind, so unlike the per-node declaration it is a claim about
   *  the host: a host that does not advertise `capabilities.compensation` MUST
   *  refuse it with `capability_required`. On expansion it becomes the registered
   *  definition's `settings.compensation` (copy / accept-if-deep-equal / conflict —
   *  never merge). Absent ⇒ the chain expresses no policy and inherits the
   *  parent's (or none). */
  compensation?: CompensationPolicy;
}
interface ChainPackManifest {
  name: string;
  version: string;
  kind: string;
  /** Optional top-level pack keywords (schema-permitted). The first keyword,
   *  when present, is surfaced as a presentational template category (the
   *  builder gallery chip) — host-only, never touches the chain object. */
  keywords?: string[];
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

// ── schema validators (lazy singletons, mirrors connectionPackLoader) ──
const CHAIN_MANIFEST_SCHEMA = 'workflow-chain-pack-manifest.schema.json';

/** Which corpus tree a chain-pack manifest is validated against. */
export type ChainManifestSchemaTree = 'v1' | 'v2';

/**
 * ADR 0713 / WHD-15 — a chain-pack manifest is validated against the schema of
 * the tree it was WRITTEN for, decided by the one field the two trees disagree
 * about irreconcilably: `signing`.
 *
 * `spec/v2/core/packs.md` §Signing: `signing` is `{ keyId, scheme }`, both
 * REQUIRED, `scheme` MUST be `ed25519-canonical-json`, and "`publicKeyRef` does
 * not exist". The registry publishes exactly that inside every v2 chain
 * `pack.json`. The v1 `Signing` def is CLOSED to `{ publicKeyRef, signatureRef,
 * method }` and always will be, so no single schema admits both populations.
 *
 * So: a `signing` object carrying `keyId` or `scheme` CLAIMS the v2 shape and goes
 * to `schemas/v2/` WHOLE — a half-v2 block (`scheme` alone, or `keyId` beside a v1
 * `method`) is then refused by the schema that owns the shape, with its message,
 * instead of by v1's "must NOT have additional properties". A v1 block, or no
 * block, goes to the root (v1) schema exactly as it always has. The in-tree
 * vendored packs are all unsigned, so nothing in-tree changes route.
 *
 * ── What this replaced, and why it was safe to (history, kept on purpose) ──
 * Until corpus tag v2.32.0 the v2 schema ALSO carried the v1 `Signing` def, so
 * every registry-installed v2 chain pack was rejected
 * `workflow_chain_pack_manifest_invalid` (MEASURED on production revision 00705:
 * 16 of 16). ADR 0713 Phase 1b worked around it with `manifestForCorpusSchema`:
 * check the v2 block against the PROSE (`manifestSigningKeyId`), STRIP it, and
 * validate the remainder against the v1 schema. openwop#1367 fixed the corpus;
 * this routing is the host half, and it deleted that function.
 *
 * It is a reader repair, and ADR 0713's own production regression came from one
 * of those — so it was decided by measurement, not by reading the schema diff.
 * The v2 schema differs in MORE than `signing`: `engines` is closed; `typeId`,
 * `chainId` and `keyId` take the `ids.schema.json` grammars (typeId REQUIRES a
 * dotted namespace, chainId caps at 128 not 256); the extension prefix admits
 * `openwop-`. MEASURED with `scripts/adr0713-whd15-chain-schema-routing.ts`,
 * which states its predicate: the 62 in-tree chain packs (all unsigned) plus all
 * 81 published v2 chain packs (`openwop-registry` @ `c510721`, 81 of 191
 * tarballs, every one v2-signed) — ZERO verdicts differ, in either direction.
 * An installed `pack.json` is the verified tarball's, byte for byte (the ADR 0660
 * D3 re-hash in `registryInstaller` refuses anything else), so a
 * registry-INSTALLED population is a subset of the published one measured — an
 * inference from the installer, not a reading taken on the production host.
 *
 * The differences above are therefore real but UNPOPULATED: a future v2-signed
 * pack that violates one is refused here where strip-and-v1 would have admitted
 * it. That is the v2 tree's own rule arriving, not a regression — but it is a
 * change in what CAN serve, so re-run the script against a newer registry before
 * leaning on the zero.
 *
 * The prose-side `manifestSigningKeyId` check is NOT kept at this gate: the v2
 * `Signing` def enforces all three of its conditions (non-empty `keyId`, `scheme`
 * const, closed block ⇒ no `method`/`publicKeyRef`) — pinned by
 * `test/adr0713-chain-loader-v2-signing.test.ts`, not assumed. The installer
 * still calls it; that is a different reader of a different document.
 */
export function chainManifestSchemaTree(raw: unknown): ChainManifestSchemaTree {
  const signing = (raw as { signing?: unknown } | null)?.signing;
  if (!signing || typeof signing !== 'object') return 'v1';
  return 'keyId' in signing || 'scheme' in signing ? 'v2' : 'v1';
}

/** Register, under its own `$id`, every sibling schema `doc` reaches by a
 *  relative-filename `$ref` (the v2 chain schema names
 *  `ids.schema.json#/$defs/chainId`), transitively — or `ajv.compile` throws
 *  MissingRefError. Deliberately the CLOSURE and not "every file in the
 *  directory": this validator gates what serves, and an unrelated sibling that
 *  fails to register must not be able to take the chain loader down with it. */
function registerSiblingRefs(ajv: Ajv2020, dir: string, doc: unknown, seen: Set<string>): void {
  if (Array.isArray(doc)) { for (const x of doc) registerSiblingRefs(ajv, dir, x, seen); return; }
  if (!doc || typeof doc !== 'object') return;
  for (const [key, value] of Object.entries(doc)) {
    if (key !== '$ref' || typeof value !== 'string') { registerSiblingRefs(ajv, dir, value, seen); continue; }
    const file = value.split('#')[0] ?? '';
    // A sibling is a bare filename: no scheme, no path. Anything else is either a
    // local `#/…` pointer (empty `file`) or not ours to fetch.
    if (file.length === 0 || file.includes('/') || seen.has(file)) continue;
    seen.add(file);
    const sibling = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
    ajv.addSchema(sibling);
    registerSiblingRefs(ajv, dir, sibling, seen);
  }
}

const _validators: Partial<Record<ChainManifestSchemaTree, ValidateFunction>> = {};
function manifestValidator(tree: ChainManifestSchemaTree): ValidateFunction {
  const cached = _validators[tree];
  if (cached) return cached;
  const dir = tree === 'v2' ? join(SCHEMAS_DIR, 'v2') : SCHEMAS_DIR;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(dir, CHAIN_MANIFEST_SCHEMA), 'utf8')) as Record<string, unknown>;
  registerSiblingRefs(ajv, dir, schema, new Set([CHAIN_MANIFEST_SCHEMA]));
  const compiled = ajv.compile(schema);
  _validators[tree] = compiled;
  return compiled;
}

/** Presentational category for the builder gallery chip: the author-declared
 *  first `keywords` entry when present, else the pack's leaf name prettified
 *  (`core.openwop.workflows.exec-ops` → "Exec Ops"). Host-only — never requires
 *  a registry republish, so installed packs without keywords still get a
 *  meaningful chip instead of the generic "Pack" fallback. */
/** Words upper-cased whole (not title-cased) when derived from a pack name, so
 *  `it-support` → "IT Support" and `people-hr` → "People HR". */
const CATEGORY_ABBREVIATIONS = new Set([
  'it', 'hr', 'ai', 'api', 'crm', 'csm', 'kpi', 'etl', 'rag', 'seo',
  'ap', 'rfp', 'cad', 'kb', 'ui', 'ux', 'id', 'url', 'sms', 'pto',
]);

/** Prettify a pack's leaf name into a display category: title-case each word,
 *  upper-casing known abbreviations. Exported for testing. */
export function prettifyPackCategory(packName: string): string {
  const leaf = packName.split('.').pop() ?? packName;
  return leaf.split(/[-_]/).filter(Boolean)
    .map((w) => CATEGORY_ABBREVIATIONS.has(w.toLowerCase())
      ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function packCategory(manifest: ChainPackManifest): string {
  const kw = manifest.keywords?.[0]?.trim();
  return kw || prettifyPackCategory(manifest.name);
}

// ── the in-process registry of loaded chains (chainId → {packName, chain}) ──
const CHAINS = new Map<string, { packName: string; packVersion: string; chain: WorkflowChain; category?: string; sourceRoot?: string }>();

/** RFC 0133 §1.1 — the sibling `chainId`s a subChainRef points to (string refs);
 *  external `{packName,chainId,version}` refs are not sibling edges. */
function siblingSubChainRefs(chain: WorkflowChain): string[] {
  return (chain.subChains ?? [])
    .map((s) => s.ref)
    .filter((r): r is string => typeof r === 'string');
}

/** RFC 0133 §1.1 — reject a sibling-ref CYCLE across a pack's chains (a chain that
 *  transitively composes itself). Returns the chainIds on a detected cycle, or []. */
export function detectSubChainCycles(chains: WorkflowChain[]): string[] {
  const byId = new Map(chains.map((c) => [c.chainId, c]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen 1=on-stack 2=done
  const onCycle: string[] = [];
  const walk = (id: string): boolean => {
    const c = byId.get(id);
    if (!c) return false; // external/unknown ref — not a sibling cycle edge
    if (state.get(id) === 1) { onCycle.push(id); return true; }
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const ref of siblingSubChainRefs(c)) {
      if (walk(ref)) { onCycle.push(id); return true; }
    }
    state.set(id, 2);
    return false;
  };
  for (const c of chains) if (state.get(c.chainId) !== 2 && walk(c.chainId)) break;
  return [...new Set(onCycle)];
}

/** Collect every `{ type:"variable", variableName }` read reachable in a fragment's
 *  node `inputs` AND `config` (recursively into nested objects/arrays) — matching
 *  the spec reference `validateVariableReads` (openwop conformance
 *  `workflow-chain-expansion.ts`), which walks both port wiring and config. */
function collectVariableReads(chain: WorkflowChain): string[] {
  const names: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'variable' && typeof o.variableName === 'string') names.push(o.variableName);
      for (const x of Object.values(o)) walk(x);
    }
  };
  for (const n of chain.dag.nodes) { walk(n.inputs); walk(n.config); }
  return names;
}

/** RFC 0133 load-time semantic validation of ONE chain (schema already passed).
 *  Returns an error `{code,message}` or null. Closed-world so a malformed chain
 *  fails at publish/install (RFC 0131 precedent), never at instantiation. */
export function validateChainComposition(chain: WorkflowChain): { code: string; message: string } | null {
  const nodeIds = new Set(chain.dag.nodes.map((n) => n.id));
  const paramNames = new Set(Object.keys((chain.parameters as { properties?: Record<string, unknown> })?.properties ?? {}));
  const declaredRefs = new Set<string>();
  for (const s of chain.subChains ?? []) declaredRefs.add(typeof s.ref === 'string' ? s.ref : s.ref.chainId);
  const producedNames = new Set((chain.producedVariables ?? []).map((p) => p.name));

  for (const n of chain.dag.nodes) {
    // §1.2 — a fragment must NOT pin a concrete workflowId (host-specific); use subChainRef.
    if (n.config && 'workflowId' in n.config) {
      return { code: 'chain_fragment_pins_workflow_id', message: `node ${n.id} pins config.workflowId — a chain must reference a child via config.subChainRef (RFC 0133 §1.2)` };
    }
    // §1.2 — a subChainRef must resolve to a declared subChains entry.
    const ref = n.config?.subChainRef;
    if (typeof ref === 'string' && !declaredRefs.has(ref)) {
      return { code: 'sub_chain_unresolved', message: `node ${n.id} references subChainRef "${ref}" not declared in subChains[]` };
    }
  }
  // §2.2 — every producedVariables.producedBy names a real node in this fragment
  // (a producedBy pointing at nothing is a malformed PRODUCER — distinct code so an
  // operator sees which side is broken).
  for (const pv of chain.producedVariables ?? []) {
    if (!nodeIds.has(pv.producedBy)) {
      return { code: 'produced_var_producer_unknown', message: `producedVariables "${pv.name}".producedBy "${pv.producedBy}" is not a node id in this chain (RFC 0133 §2.2)` };
    }
    // §2.2 — the author-time (`parameters`) and run-scoped (`producedVariables`)
    // channels are DISJOINT; a name in both is an ambiguous read. Per the final
    // RFC 0133 error table this folds into `variable_undeclared` (the produced↔param
    // collision is not its own wire code).
    if (paramNames.has(pv.name)) {
      return { code: 'variable_undeclared', message: `producedVariables "${pv.name}" collides with a parameter name — the author-time and run-scoped channels must be disjoint (RFC 0133 §2.2)` };
    }
  }
  // §2 — every {type:variable} read resolves to a producedVariable or a param.
  for (const name of collectVariableReads(chain)) {
    if (!producedNames.has(name) && !paramNames.has(name)) {
      return { code: 'variable_undeclared', message: `a node reads variable "${name}" that is neither a producedVariable nor a parameter (RFC 0133 §2.2)` };
    }
  }
  return null;
}

/** Default roots in PRECEDENCE ORDER (ADR 0370 — first root to register a
 *  chainId wins, EXCEPT where a lower root carries a NEWER SemVer of the same
 *  pack; see the WF-DUP-2 block in `loadWorkflowChainPacks`):
 *   1. the operator override dir (`OPENWOP_WORKFLOW_CHAIN_PACKS_DIR`) — an
 *      explicit operator choice beats everything;
 *   2. the registry-install dir (`OPENWOP_PACK_DIR` — ADR 0163 Phase 7: a
 *      `kind:"workflow-chain"` pack named in `OPENWOP_INSTALL_PACKS` is fetched
 *      + Ed25519/SRI-verified from packs.openwop.dev at boot) — a pinned
 *      registry UPDATE must beat the image-vendored copy;
 *   3. the in-tree `examples/workflow-chain-packs/` fallback.
 *  The pre-ADR-0370 order was the reverse, so a registry-installed update
 *  could never win against the older vendored copy AND every image-vendored
 *  pack that was also installed produced a daily wall of
 *  `workflow_chain_id_conflict` rejections. The loader kind-filters, so
 *  non-workflow-chain packs in the install dir are ignored. */
export function defaultWorkflowChainPackRoots(): string[] {
  const repoRoot = dirname(SCHEMAS_DIR);
  // ADR 0626 P2 — `OPENWOP_WORKFLOW_CHAIN_EXAMPLES=0` drops root 3, the in-tree
  // demo gallery. Root 1 is a PRECEDENCE override, not an exclusive one: an
  // operator who pins their own chains still inherits every `examples/` chain
  // underneath, which is wrong for two real cases and one test.
  //
  //  - a white-label adopter ships their own catalogue and does not want ours in
  //    the `/builder` gallery or the `/` picker;
  //  - the e2e boot needs a gallery that is a function of the SPEC, not of the
  //    repository: every reworded description in `examples/` reflows the
  //    `/builder` snapshot (measured 2026-09-02 — `people-hr` gained a sentence
  //    and the page grew 348px), which is what made that baseline decay in days.
  //
  // `!== '0'` matches `OPENWOP_CHAIN_SUBCHAINS` in this same file, so the two
  // loader flags read alike. Default is unchanged: examples load unless asked
  // otherwise.
  const examplesRoot = process.env.OPENWOP_WORKFLOW_CHAIN_EXAMPLES === '0'
    ? ''
    : join(repoRoot, 'examples', 'workflow-chain-packs');
  return [
    process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR ?? '',
    resolveDefaultPackDir(),
    examplesRoot,
  ].filter((p) => p.length > 0);
}

/** Discover + validate + register every `kind:"workflow-chain"` pack under `roots`.
 *  Collects errors (never throws on a bad pack — boot must not abort). */
export function loadWorkflowChainPacks(opts: { roots: string[] }): ChainPackLoadOutcome {
  const installed: ChainPackLoadResult[] = [];
  const errors: ChainPackLoadError[] = [];
  // The v1 validator is compiled up front, as it always was: every in-tree pack
  // needs it, and a host that cannot read its own root schema has nothing to load.
  const validateV1 = manifestValidator('v1');
  // ADR 0427 — registry-installed packs verify against the pinned keyring at
  // load time; the other roots keep the R7 trusted-source posture.
  const registryInstallDir = resolveDefaultPackDir();
  const requireSignatures = process.env.OPENWOP_REQUIRE_CHAINPACK_SIGNATURES === 'true';
  const keyring = loadPinnedKeyring();

  for (const root of opts.roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (isParkedPackDirName(entry)) continue;
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
      // WHD-15 — the manifest goes WHOLE to the schema of the tree it was written
      // for (see `chainManifestSchemaTree`). The v2 validator is compiled on first
      // need and a failure to compile it is COLLECTED, per pack: a host whose
      // `schemas/v2/` is missing or uncompilable refuses v2-shaped packs by name —
      // fail closed, never "strip the block and ask v1 instead", which is the
      // workaround this replaced — while every v1-shaped pack keeps loading.
      const tree = chainManifestSchemaTree(raw);
      let validate: ValidateFunction;
      try {
        validate = tree === 'v1' ? validateV1 : manifestValidator(tree);
      } catch (e) {
        errors.push({
          pack: entry,
          code: 'workflow_chain_pack_schema_unavailable',
          message: `cannot compile the ${tree} chain-pack manifest schema: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      if (!validate(raw)) {
        errors.push({
          pack: entry,
          code: 'workflow_chain_pack_manifest_invalid',
          message: JSON.stringify(validate.errors),
        });
        continue;
      }
      const manifest = raw as ChainPackManifest;
      // ADR 0427 — verify BEFORE any chain registers (a partial load after a
      // signature failure would be fail-open for the registered subset).
      if (root === registryInstallDir) {
        // The chain-pack schema's signing block carries the pinned key id in
        // `publicKeyRef` (the registry manifest documents it as the legacy
        // ALIAS of `keyId`); normalize before the pinned check.
        const rawSigning = (manifest as { signing?: SigningRefs & { publicKeyRef?: string } }).signing;
        const signing: SigningRefs | undefined = rawSigning
          ? { ...rawSigning, keyId: rawSigning.keyId ?? rawSigning.publicKeyRef }
          : undefined;
        // ADR 0713 OQ3 — a v2 install carries no detached `signatureRef` file:
        // the installer verified the Ed25519 signature (and the ADR 0660 namespace)
        // over the canonical `pack.json` at INSTALL time, then wrote the marker with
        // each load-bearing file's hash. `verifyPinned` only knows the v1 shape, so
        // every v2 chain pack read `unsigned` here (MEASURED in production,
        // 2026-09-17) and would be refused under OPENWOP_REQUIRE_CHAINPACK_SIGNATURES.
        // For the v2 shape the attestation is that marker, re-verified against the
        // files on disk — the same hasher `packTrust` uses; a tampered or unmarked
        // install is `failed`, never trusted.
        const isV2Signing = !!rawSigning
          && typeof (rawSigning as { keyId?: unknown }).keyId === 'string'
          && typeof (rawSigning as { scheme?: unknown }).scheme === 'string';
        const verdict = isV2Signing
          ? (verifyInstalledPack(join(root, entry)) === null ? 'trusted' as const : 'failed' as const)
          : verifyPinned(
            join(root, entry),
            { name: manifest.name, version: manifest.version, ...(signing ? { signing } : {}) },
            keyring,
          );
        if (verdict !== 'trusted') {
          if (requireSignatures) {
            errors.push({
              pack: manifest.name,
              code: `workflow_chain_pack_signature_${verdict}`,
              message: `registry-installed chain pack is not trusted (${verdict}) and OPENWOP_REQUIRE_CHAINPACK_SIGNATURES is set`,
            });
            continue; // fail closed: nothing from this pack loads
          }
          log.warn('chainpack_signature_unverified', { pack: manifest.name, version: manifest.version, verdict });
        }
      }
      // RFC 0133 §1.1 — reject a sibling sub-chain CYCLE across this pack's chains
      // (a chain that transitively composes itself); the whole pack fails closed.
      const cycle = detectSubChainCycles(manifest.chains);
      if (cycle.length) {
        errors.push({ pack: manifest.name, code: 'sub_chain_cycle', message: `sub-chain cycle among chains: ${cycle.join(' → ')}` });
        continue; // nothing from this pack loads
      }
      const chainIds: string[] = [];
      for (const chain of manifest.chains) {
        // RFC 0133 — closed-world composition validation (subChainRef resolution,
        // no pinned workflowId, producedVariables producer/read declaration).
        const compositionErr = validateChainComposition(chain);
        if (compositionErr) {
          errors.push({ pack: manifest.name, ...compositionErr });
          continue;
        }
        const existing = CHAINS.get(chain.chainId);
        if (existing) {
          // ADR 0370 — roots iterate in PRECEDENCE order, so an already-
          // registered chainId from the SAME pack name is just this pack's
          // copy in a lower-precedence root (image-vendored twin of an
          // installed pack, or an identical re-load): shadowed by design,
          // logged quietly, never an error. This was the daily wall of 51
          // `workflow_chain_id_conflict` rejections. A duplicate from a
          // DIFFERENT pack name is a true collision and stays a hard error
          // (last-writer-wins is still avoided: no silent shadow between
          // unrelated packs).
          if (existing.packName === manifest.name) {
            // WF-DUP-2 — precedence ALONE is not a safe tie-break. Root order put
            // the registry-install dir ABOVE `examples/`, so an OLDER installed
            // copy shadowed a NEWER image-vendored one and the only trace was an
            // `info` line: a fix shipped in-tree was inert on every host that had
            // installed the pack, and indistinguishable at the run boundary from a
            // branch that never fired. Resolution is now VERSION-AWARE — the higher
            // SemVer wins regardless of root — with one deliberate exception below.
            const explicitOverrideRoot = process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR ?? '';
            const keptIsOperatorPin =
              explicitOverrideRoot.length > 0 && existing.sourceRoot === explicitOverrideRoot;
            // Both versions came through the schema gate, and BOTH trees' schemas pin
            // `version` to the SemVer 2.0.0 pattern — so the compare is always
            // defined and there is no unorderable case to fall back from.
            const cmp = semverCompare(manifest.version, existing.packVersion);

            if (cmp > 0 && !keptIsOperatorPin) {
              // The lower-precedence root carries a NEWER release — it wins. WARN,
              // not info: a host silently running a version other than the one its
              // highest-precedence root holds is exactly what needs to be visible.
              log.warn('workflow_chain_pack_duplicate_upgraded', {
                pack: manifest.name, chainId: chain.chainId,
                kept: manifest.version, superseded: existing.packVersion,
                keptRoot: root, supersededRoot: existing.sourceRoot,
              });
              // Keep `installed` honest: the superseded copy no longer owns this
              // chainId, and a pack left owning NONE is not installed at all.
              const prior = installed.find(
                (p) => p.packName === manifest.name && p.packVersion === existing.packVersion,
              );
              if (prior) {
                prior.chainIds = prior.chainIds.filter((id) => id !== chain.chainId);
                if (prior.chainIds.length === 0) installed.splice(installed.indexOf(prior), 1);
              }
              CHAINS.set(chain.chainId, {
                packName: manifest.name, packVersion: manifest.version, chain,
                category: packCategory(manifest), sourceRoot: root,
              });
              chainIds.push(chain.chainId);
              continue;
            }
            if (cmp > 0) {
              // The operator's explicit `OPENWOP_WORKFLOW_CHAIN_PACKS_DIR` pin still
              // beats everything — an explicit choice must not be auto-upgraded out
              // from under them — but keeping the OLDER copy is stated at WARN with
              // BOTH versions, never the quiet info that hid WF-DUP-2.
              log.warn('workflow_chain_pack_duplicate_older_kept', {
                pack: manifest.name, chainId: chain.chainId,
                kept: existing.packVersion, shadowed: manifest.version,
                keptRoot: existing.sourceRoot, shadowedRoot: root,
                reason: 'operator_override_root',
              });
              continue;
            }
            // WF-DUP-1 — a SAME-VERSION shadow with DIFFERENT content means the two
            // copies drifted without a version bump (typically a stale installed pack
            // shadowing the updated in-repo copy on a dev machine). The precedence
            // keep is unchanged, but that state warrants a WARN, not the quiet info.
            if (existing.packVersion === manifest.version && canonicalize(existing.chain) !== canonicalize(chain)) {
              // ADR 0713 OQ5 — a same PACK version is not a same CHAIN version. The
              // per-chain `version` is what expansion identity hashes, and the pack
              // version can lag it: on 2026-09-17 production kept the registry's
              // `approvals 1.0.4` (chains @1.0.0, pre-ADR-0582, ungated) over the
              // vendored `approvals 1.0.4` (chains @1.0.1, gated) because this branch
              // only warned. When the shadowed copy's CHAIN version is higher it wins,
              // exactly as a higher pack version does above — same operator-pin
              // exception. Equal chain versions keep the precedence winner (unchanged).
              const chainCmp = semverCompare(chain.version, existing.chain.version);
              if (chainCmp > 0 && !keptIsOperatorPin) {
                log.warn('workflow_chain_pack_duplicate_chain_upgraded', {
                  pack: manifest.name, chainId: chain.chainId, packVersion: manifest.version,
                  kept: chain.version, superseded: existing.chain.version,
                  keptRoot: root, supersededRoot: existing.sourceRoot,
                });
                const prior = installed.find(
                  (p) => p.packName === manifest.name && p.packVersion === existing.packVersion && p.chainIds.includes(chain.chainId),
                );
                if (prior) {
                  prior.chainIds = prior.chainIds.filter((id) => id !== chain.chainId);
                  if (prior.chainIds.length === 0) installed.splice(installed.indexOf(prior), 1);
                }
                CHAINS.set(chain.chainId, {
                  packName: manifest.name, packVersion: manifest.version, chain,
                  category: packCategory(manifest), sourceRoot: root,
                });
                chainIds.push(chain.chainId);
                continue;
              }
              // The roots name WHICH copy is stale — the one thing a dev needs.
              log.warn('workflow_chain_pack_duplicate_content_drift', {
                pack: manifest.name, chainId: chain.chainId, version: manifest.version,
                keptRoot: existing.sourceRoot, shadowedRoot: root,
              });
              continue;
            }
            log.info('workflow_chain_pack_duplicate_shadowed', {
              pack: manifest.name, chainId: chain.chainId,
              kept: existing.packVersion, shadowed: manifest.version,
              keptRoot: existing.sourceRoot, shadowedRoot: root,
            });
            continue;
          }
          errors.push({
            pack: manifest.name,
            code: 'workflow_chain_id_conflict',
            message: `chainId ${chain.chainId} already registered by pack ${existing.packName}`,
          });
          continue;
        }
        CHAINS.set(chain.chainId, { packName: manifest.name, packVersion: manifest.version, chain, category: packCategory(manifest), sourceRoot: root });
        chainIds.push(chain.chainId);
      }
      // A fully-shadowed pack (all chains already registered by its own
      // higher-precedence copy) is not "installed" — listing it with zero
      // chains would misread as an empty pack.
      if (chainIds.length > 0) installed.push({ packName: manifest.name, packVersion: manifest.version, chainIds });
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
export function getChain(chainId: string): { packName: string; packVersion: string; chain: WorkflowChain; category?: string } | null {
  return CHAINS.get(chainId) ?? null;
}

/** All loaded chains (UI/catalog listing). */
export function listChains(): ReadonlyArray<{ packName: string; packVersion: string; chain: WorkflowChain; category?: string }> {
  return [...CHAINS.values()];
}

/** RFC 0013 + RFC 0124 (WCP4) — single source of truth for the
 *  `capabilities.workflowChainPacks` advertisement, co-located with the
 *  expansion implementation so advertise/serve can't drift.
 *
 *  - `supported: true` — this host implements editor-time chain-pack expansion
 *    (`expandChain` + the `/workflows/from-chain` route + the vendored packs).
 *  - `deferredParameters.supported` — the RFC 0124 per-run deferral mode:
 *    `expandChain({deferred})` materializes `{{params.x}}` → top-level
 *    `variables[]` (`source:"secret"` for `x-openwop-sensitive`), driven at
 *    author time by the real `POST /workflows/from-chain {deferred:true}` route
 *    and bound per run by `deferredConfigurableInputs()` at run-create/`:fork`.
 *    Witnessed by the server-free `workflow-chain-deferred-parameters.test.ts`
 *    always-on legs (materialization / fail-closed / credentialRef shape) plus
 *    this host's own gated runpath vitest. Honest ONLY when the prompt-bearing
 *    rewrite path is available — the schema precondition is `prompts.supported`
 *    with `variable` in `prompts.variableSources` — so a deployer who tightens
 *    the single `promptHostConfig` module can't leave a dishonest deferred claim.
 *  - `hostExpansionSeam` is deliberately OMITTED: this host serves neither the
 *    RFC 0013 `/v1/host/sample/workflow-chain:expand` seam nor the RFC 0124
 *    `/v1/host/sample/chain/deferred-expand` seam, so those conformance scenarios
 *    soft-skip for us (the host-expansion scenario gates on `hostExpansionSeam`
 *    per openwop-conformance ≥1.51.0 / erratum #828; the deferred gated legs
 *    explicitly soft-skip on a 404 from the unwired seam). */
export function workflowChainPacksCapability(): {
  supported: true;
  deferredParameters: { supported: boolean };
  subChains?: { supported: boolean; maxDepth: number };
  hostExpansionSeam?: true;
} {
  const prompts = getPromptsHostConfig();
  const deferredParameterMode = prompts.supported && prompts.variableSources.includes('variable');
  // RFC 0013 erratum #828 — the OPTIONAL host-expansion test-seam advertisement.
  // Advertised ONLY when the `/v1/host/sample/workflow-chain:expand` witness seam is
  // actually served (co-gated with it on OPENWOP_TEST_SEAM_ENABLED), so the claim is
  // honest: a host that doesn't serve the seam omits the flag → the conformance
  // scenario soft-skips. openwop-conformance ≥1.52.0 loads the published
  // `vendor.openwop.workflow-chain-sample` fixture and checks the seam output.
  // CORRECTED 2026-08-13 (ADR 0550 P2) — the env gate alone was NOT sufficient.
  // The seam resolves its fixture pack from `@openwop/openwop-conformance` at
  // REQUEST time, and that is a devDependency: the runtime image runs
  // `npm ci --omit=dev` (Dockerfile:85), so it is absent there. The container
  // therefore ADVERTISED `hostExpansionSeam` and then answered 404
  // `pack_not_found` — a dishonest wire claim, invisible to the source lane
  // because devDependencies happen to be installed there.
  //
  // Advertising and SERVING call the same function (see
  // routes/workflowChainExpandSeam.ts), so they cannot disagree.
  const hostExpansionSeam = isChainExpansionSeamServable() ? true : undefined;
  // RFC 0133 §1 — runtime child-chain dispatch (sub-chains). This host DOES support
  // it (the executor already runs core.subWorkflow / core.dispatch child runs, and
  // `from-chain` co-registers each child as its own owned workflow). The advert is
  // HONEST-BY-CONSTRUCTION with the from-chain behavior: `OPENWOP_CHAIN_SUBCHAINS=0`
  // flips BOTH the advertisement here AND the `coRegisterSubChains` refusal off, so a
  // deployer that disables runtime child dispatch never leaves a dishonest claim —
  // and the `chain-subchain-unsupported-refused` scenario becomes witnessable by
  // flipping this env (advertise nothing → from-chain returns `sub_chain_unsupported`
  // 422). `maxDepth` = `MAX_SUB_CHAIN_DEPTH` (the co-registration DoS bound).
  const subChainsSupported = process.env.OPENWOP_CHAIN_SUBCHAINS !== '0';
  return {
    supported: true,
    deferredParameters: { supported: deferredParameterMode },
    ...(subChainsSupported ? { subChains: { supported: true, maxDepth: MAX_SUB_CHAIN_DEPTH } } : {}),
    ...(hostExpansionSeam ? { hostExpansionSeam } : {}),
  };
}

/** One connection binding a chain's DAG names (day-1 UX P3 — the pre-flight).
 *  `ref` is the raw `config.connectionRef` (a connection-pack name,
 *  `core.openwop.connections.<providerId>` — RFC 0095 packs key their provider
 *  by the final segment); `providerInstalled` reports whether THIS host has
 *  that provider manifest (built-in or pack-loaded). Whether the CALLER has an
 *  active connection is joined client-side against its own /connections rows —
 *  this stays host-global, never caller-specific. */
export interface ChainConnectionRequirement {
  ref: string;
  providerId: string;
  providerInstalled: boolean;
}
/** A toggle-gated feature surface the chain reads (ADR 0191 Phase 2). */
export interface ChainFeatureRequirement {
  /** The feature/toggle id (e.g. `crm`), from a `feature.<id>.nodes.*` typeId. */
  id: string;
  /** Human label from the feature's toggle default (falls back to the id). */
  label: string;
}

export interface ChainRequirements {
  /** Node typeIds the chain uses that this host cannot resolve (install gap). */
  missingNodeTypeIds: string[];
  connections: ChainConnectionRequirement[];
  /** How many human-approval gates the chain contains (day-1 UX P12/F2 —
   *  the trust signal the pre-flight surfaces: external sends wait for you). */
  approvalGateCount: number;
  /** Toggle-gated `ctx.features.<id>` surfaces the chain's nodes read (ADR 0191
   *  Phase 2). Installed-but-gated: a `feature.<id>.nodes.*` node resolves on
   *  the host yet throws `host_capability_disabled` at runtime when the feature
   *  is off — the exact gap `missingNodeTypeIds` (uninstalled) cannot see.
   *  ALWAYS-ON features (no toggle default, e.g. `kb`) are omitted — they never
   *  need enabling. The caller joins enablement client-side. */
  requiredFeatures: ChainFeatureRequirement[];
}

/** Statically derive a chain's requirements for the template pre-flight:
 *  pure over (chain, the host's known typeIds, a provider-exists predicate)
 *  so it is unit-testable without the registries. */
export function chainRequirements(
  chain: WorkflowChain,
  knownTypeIds: ReadonlySet<string>,
  providerExists: (providerId: string) => boolean,
  /** Resolve a feature id to its toggle-gated presence: `{ label }` when the id
   *  names a toggle-GATED feature, or `null` when it is always-on / unknown (so
   *  it is omitted from `requiredFeatures`). Injected — keeps the loader pure
   *  and decoupled from the feature-toggle registry (mirrors `providerExists`).
   *  Defaults to "nothing is gated" so older callers keep the prior shape. */
  resolveFeature: (id: string) => { label: string } | null = () => null,
): ChainRequirements {
  const nodeTypeIds = [...new Set(chain.dag.nodes.map((n) => n.typeId))];
  const missingNodeTypeIds = nodeTypeIds.filter((t) => !knownTypeIds.has(t));
  // Feature surfaces: a `feature.<id>.nodes.*` node reads `ctx.features.<id>`,
  // which is toggle-gated. Derive the distinct gated ids (always-on features
  // resolve to null and drop out).
  const requiredFeatures = [
    ...new Map(
      nodeTypeIds
        .map((t) => /^feature\.([^.]+)\.nodes\./.exec(t)?.[1])
        .filter((id): id is string => typeof id === 'string')
        .map((id) => [id, resolveFeature(id)] as const)
        .filter((e): e is readonly [string, { label: string }] => e[1] !== null)
        .map(([id, f]) => [id, { id, label: f.label }] as const),
    ).values(),
  ];
  const refs = [
    ...new Set(
      chain.dag.nodes
        .map((n) => n.config?.connectionRef)
        .filter((r): r is string => typeof r === 'string' && r.length > 0),
    ),
  ];
  const connections = refs.map((ref) => {
    const providerId = ref.split('.').pop() ?? ref;
    return { ref, providerId, providerInstalled: providerExists(providerId) };
  });
  // Approval/HITL gates by typeId convention (core.chat.approvalGate, the
  // core.openwop.hitl.* family) — a count, not identity, so packs can add
  // gate flavors without a loader change.
  const approvalGateCount = chain.dag.nodes.filter((n) => /approvalgate|\.hitl\./i.test(n.typeId)).length;
  return { missingNodeTypeIds, connections, approvalGateCount, requiredFeatures };
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

/** Stable, hash-derived expansion id (R2 — no clock/randomness).
 *
 *  RFC 0013 §"Expansion semantics" step 6 (2026-07-04 amendment): because Path-A
 *  expansion FREEZES the resolved params into node `config`/`inputs`, the id MUST
 *  fold the canonical params in — a `chainId`-only key would silently OVERWRITE a
 *  second drop of the same chain with different params (both would hash to the
 *  same `workflowId = chainId:expansionId` and collide in the owned-workflow
 *  store). Canonical = keys sorted, so `expandChain` stays pure + deterministic:
 *  same (chain, params) ⇒ same id ⇒ byte-identical definition. */
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

/** Options for expansion. `isTypeIdKnown` (when provided) enforces RFC 0013's
 *  `chain_unresolvable_typeid` — every fragment typeId must resolve on this host
 *  (R8). Omit it where typeId existence is checked elsewhere (e.g. at dispatch).
 *  `params`, when provided, are the values FROZEN into the expanded definition
 *  (RFC 0013 Path-A expansion-time substitution); re-parameterize by re-expanding
 *  from `metadata.expandedFrom` with new params.
 *
 *  `deferred` (RFC 0124 / WCP4) opts into the capability-gated deferred-parameter
 *  mode: chain `parameters` are materialized as run-overridable `variables[]` and
 *  `{{params.*}}` tokens are rewritten to portable runtime bindings instead of
 *  being frozen — so one owned workflow is re-runnable with different values per
 *  run via `configurable`, WITHOUT leaving a non-portable token in the definition.
 *  Both modes keep the persisted def free of `{{params.*}}` tokens. */
export interface ExpandOptions {
  params?: Record<string, unknown>;
  isTypeIdKnown?: (typeId: string) => boolean;
  deferred?: boolean;
  /** P2 — required config keys for a node typeId (from the node pack's
   *  `configSchema.required`). Supplying it turns on the REPORT-ONLY
   *  missing-config check; see `findMissingRequiredConfig`. */
  requiredConfigKeysFor?: (typeId: string) => readonly string[];
  /** RFC 0157 §B / expansion step 9b — the `settings.compensation` the PARENT
   *  workflow already carries, when a chain is being spliced into an existing
   *  definition. `from-chain` mints a fresh workflow and so passes none (the
   *  chain's policy is copied); a host editor splicing into an authored workflow
   *  passes the parent's, and expansion then accepts a deep-equal policy or
   *  refuses `chain_compensation_policy_conflict`. NEVER merged. */
  parentSettingsCompensation?: CompensationPolicy;
}

/** One chain node whose authored `config` omits a key its node type requires. */
export interface MissingConfigFinding {
  chainId: string;
  nodeId: string;
  typeId: string;
  missing: string[];
}

/**
 * Nodes whose `config` omits a key the node type declares REQUIRED.
 *
 * §Correction (grade-code HIGH-1) — THIS NOW EVALUATES THE **EXPANDED**
 * DEFINITION, not the authored chain, and the earlier "a `{{params.X}}` token
 * counts as present when the param is declared required" exemption is GONE.
 *
 * That exemption was wrong in the only way that matters: with required-param
 * enforcement reverted (ADR 0497 D5), a user copies a template with `params: {}`
 * — the documented "just copy" path — expansion DROPS the unresolved key, and
 * the minted node carries `config: {}`. Proven by execution:
 * `commerce.post-purchase-thankyou`'s `email-send` mints `config: {}` while
 * `email-send.config.json` requires `from` and the node destructures it blind.
 * That is the original incident, byte for byte. The authored chain looked
 * conformant; what shipped was not. Counting the authored form hid 40 nodes.
 *
 * WHY THIS EXISTS. `expandChain` already refuses an unresolvable *typeId*
 * (`chain_unresolvable_typeid`, R8) but never checked node CONFIG, so a chain
 * could ship a node missing required config and fail only when the run reached
 * it. That is how `exec-ops.daily-briefing` shipped a `core.ai.chatCompletion`
 * with `config: {}` and died in production with `Provider "undefined"`.
 *
 * KEY-PRESENCE, not value validation: a chain legitimately authors
 * `"provider": "{{params.provider}}"`, whose VALUE is only known once expansion
 * freezes params in. A param token counts as present ONLY if that param has a
 * default or is declared required — a whole-value token with neither resolves to
 * `undefined` (`resolveTokenString`) and reproduces the bug one layer along.
 */
/** One authored value that never got a param, still empty on the live node. */
export interface UnfilledParamFinding {
  nodeId: string;
  key: string;
  param: string;
  /** ADR 0507 — the token was EMBEDDED in a larger string, so it froze to `''`
   *  rather than vanishing. The node then succeeds on truncated input instead of
   *  failing, which is the more dangerous of the two families. */
  embedded?: boolean;
}

/** Read a dotted/indexed path (`a.b[0].c`) written by `collectUnresolved`. */
function readPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split('.')) {
    for (const part of seg.split('[')) {
      if (cur === undefined || cur === null) return undefined;
      const key = part.endsWith(']') ? part.slice(0, -1) : part;
      if (key === '') continue;
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return cur;
}

/**
 * ADR 0504 — the params `expandChain` recorded as unfrozen, RE-CHECKED against
 * the definition as it stands now.
 *
 * Re-checking rather than trusting the record is the whole point: a template is
 * allowed to be copied with blanks (the "Use template = just copy" contract that
 * the ADR 0498 enforcement revert protected), and the user is expected to fill
 * them in the builder. A stale metadata list would then block a workflow the
 * user had already fixed. So the record says WHICH values were never frozen; the
 * live node says whether they are still empty. Only both together block a run.
 *
 * A node deleted in the builder drops out — it cannot block anything.
 */
export function findUnfilledExpansionParams(def: WorkflowDefinition): UnfilledParamFinding[] {
  const recorded = (def.metadata as { unresolvedParams?: unknown } | undefined)?.unresolvedParams;
  if (!Array.isArray(recorded) || recorded.length === 0) return [];
  const byId = new Map(def.nodes.map((n) => [n.nodeId, n]));
  const out: UnfilledParamFinding[] = [];
  for (const entry of recorded as UnfilledParamFinding[]) {
    if (!entry || typeof entry.nodeId !== 'string' || typeof entry.key !== 'string') continue;
    const node = byId.get(entry.nodeId);
    if (!node) continue;
    // ADR 0507 — an EMBEDDED finding cannot use the same re-check. The live value
    // is the INTERPOLATED string (`"…Invoice: "`), which is long and truthy, so the
    // "is it still empty?" test would silently drop exactly the findings that
    // matter most. The absence is inside the string, not instead of it.
    //
    // Reported unconditionally instead. The residual false positive — someone
    // hand-edits the prompt in the builder to include the text — is acceptable
    // because nothing BLOCKS on this: it is surfaced on the `from-chain` response,
    // never enforced (ADR 0504 measured why enforcement is not viable).
    if (entry.embedded) { out.push(entry); continue; }
    const v = readPath(node.config, entry.key) ?? readPath(node.inputs, entry.key);
    if (v === undefined || v === null || v === '') out.push(entry);
  }
  return out;
}

export function findMissingRequiredConfig(
  nodes: ReadonlyArray<{ id?: string; nodeId?: string; typeId: string; config?: unknown }>,
  requiredConfigKeysFor: (typeId: string) => readonly string[],
  chainId = '',
): MissingConfigFinding[] {
  const out: MissingConfigFinding[] = [];
  for (const n of nodes) {
    const required = requiredConfigKeysFor(n.typeId);
    if (required.length === 0) continue;
    const cfg = (n.config ?? {}) as Record<string, unknown>;
    const missing = required.filter((k) => {
      const v = cfg[k];
      // Absent, or present-but-unresolvable. A `{{params.X}}` token that
      // survives here never had a value (expansion strips resolved ones), and
      // `undefined` is what an unresolved whole-value token freezes to.
      if (!(k in cfg) || v === undefined || v === null) return true;
      return typeof v === 'string' && /\{\{\s*params\./.test(v);
    });
    if (missing.length > 0) {
      out.push({ chainId, nodeId: n.nodeId ?? n.id ?? '', typeId: n.typeId, missing });
    }
  }
  return out;
}


/** Shape of one declared chain parameter (a JSON-Schema property node) plus the
 *  OPTIONAL `x-openwop-sensitive` secret-class hint (RFC 0124 §Security). The hint
 *  is manifest-declarative + portable: every host honors the author's marking
 *  rather than guessing. */
interface ChainParamSpec {
  type?: string;
  description?: string;
  default?: unknown;
  'x-openwop-sensitive'?: boolean;
  /** RFC 0136 — advisory JSON-Schema `format` hint. Chain `parameters` is
   *  `additionalProperties: true`, so this arrives free-form. Propagated verbatim
   *  onto the materialized `WorkflowVariable` in deferred mode (requirement 7),
   *  string-typed only (requirement 1), unvalidated (an unknown value is still
   *  copied — requirement 2). Deliberately NOT carried into `configurableSchema`
   *  (requirement 8): that is the run-options validation surface, where a
   *  format-asserting validator would convert an advisory hint into a
   *  run-rejection path, violating the absolute requirement 3. */
  format?: string;
}

/** RFC 0124 G3 — inline `config` prompt-body keys that the deferred-mode lift turns
 *  into a minted PromptTemplate + `*PromptRef`. A `{{params.x}}` in one of these
 *  defers portably (via a `{{varName}}` slot), so it is a SAFE position for a
 *  sensitive param (redacted at compose, never persisted). Any OTHER config key
 *  freezes, so a sensitive param there still fails closed. */
const LIFTABLE_PROMPT_BODY_KEYS: Record<string, { kind: PromptTemplate['kind']; refKey: string }> = {
  systemPrompt: { kind: 'system', refKey: 'systemPromptRef' },
  userPrompt: { kind: 'user', refKey: 'userPromptRef' },
};

/** RFC 0124 §Security fail-closed gate. A `sensitive` param MUST NOT be resolved
 *  by expansion-time substitution — freezing it into persisted `config`/`inputs`
 *  (or into a `variables[].defaultValue`) is a secret-at-rest leak (SR-1). It is
 *  safe only in a DEFERRED position that never persists the value: a whole-value
 *  `{{params.x}}` top-level `node.inputs` entry (→ variable-sourced PortValue), or
 *  a liftable prompt-body `config` key (→ minted PromptTemplate `{{varName}}` slot,
 *  redacted at compose). Any other occurrence — a NON-prompt `config` key, an
 *  embedded/nested `inputs` token, or non-deferred (Path A) mode entirely — MUST
 *  fail closed rather than bake the secret. */
function assertSensitiveDeferrable(
  chain: WorkflowChain,
  sensitiveParams: ReadonlySet<string>,
  deferred: boolean,
): void {
  if (sensitiveParams.size === 0) return;
  const refuse = (p: string, where: string): never => {
    throw new OpenwopError(
      'validation_error',
      `sensitive_param_not_deferrable: parameter '${p}' is marked x-openwop-sensitive but appears at ${where}, which would freeze the secret into the persisted definition (SR-1). It MUST be supplied per run in deferred mode; the host fails closed.`,
      422,
      { param: p, where },
    );
  };
  const mentions = (v: unknown, p: string): boolean =>
    JSON.stringify(v ?? null).includes(`{{params.${p}}}`);
  for (const p of sensitiveParams) {
    // Non-deferred (Path A) mode freezes everything → any sensitive param is unsafe.
    if (!deferred) {
      for (const n of chain.dag.nodes) {
        if (mentions(n.config, p) || mentions(n.inputs, p)) refuse(p, `expansion-time (non-deferred) node '${n.id}'`);
      }
      continue;
    }
    // RFC 0124 §Security amendment — a `sensitive` param is deferrable ONLY in a
    // prompt-body position (→ a `source:"secret"` PromptVariable). There is no
    // `{type:"secret"}` node-input PortValue in v1, so a sensitive param in a
    // whole-value `node.inputs` entry (or any non-prompt position) MUST fail closed
    // rather than materialize a plaintext `source:"variable"` value.
    for (const n of chain.dag.nodes) {
      // config: a liftable prompt-body key defers the param via the G3 lift (safe,
      // → source:secret); any OTHER config key freezes → refuse.
      for (const [key, val] of Object.entries((n.config ?? {}) as Record<string, unknown>)) {
        if (key in LIFTABLE_PROMPT_BODY_KEYS && typeof val === 'string') continue; // deferrable (lift → source:secret)
        if (mentions(val, p)) refuse(p, `node '${n.id}' config.${key} (non-prompt / frozen)`);
      }
      // inputs: NO position is a secure home for a sensitive param (no source:secret
      // PortValue in v1) → any occurrence fails closed.
      for (const [port, val] of Object.entries(n.inputs ?? {})) {
        if (mentions(val, p)) refuse(p, `node '${n.id}' inputs.${port} (no source:secret node-input in v1)`);
      }
    }
  }
}

/**
 * Expand a chain into a concrete, FROZEN `WorkflowDefinition` (RFC 0013 §expansion):
 * resolve params → substitute `{{params.*}}` at EXPANSION TIME → deterministically
 * rewrite node ids → map fragment edges → mark the terminal node `primary` →
 * validate the result through the shared `validateWorkflowDefinition` (R8). Pure +
 * deterministic: same (chain, params) ⇒ byte-identical definition.
 *
 * RFC 0013 requires expansion-time substitution: a persisted `WorkflowNode.config`/
 * `inputs` has no runtime `{{...}}` interpolation surface, so a token left in the
 * definition would ship verbatim to any other host and break portability. Values
 * are frozen here; the definition contains ZERO `{{params.*}}` tokens. Re-run with
 * different values = re-expand from `metadata.expandedFrom`. (The reusable "values
 * per run" ergonomic is the separate, capability-gated deferred mode — RFC 0124.)
 */
/**
 * RFC 0157 expansion step 6b — rewrite fragment node-id references inside a
 * `compensation.inputMapping` exactly as edge endpoints are rewritten. A
 * mapping reads recorded facts by node id (`${nodes.reserve.output.id}` /
 * `nodes.reserve.output.id`), and expansion prefixes every fragment node id —
 * so without this the compensator would read a node that no longer exists under
 * that name, and the unwind would resolve nothing.
 *
 * Deliberately conservative, the same rule as edge refs: only ids that ARE
 * fragment node ids are rewritten, so a reference to a node in the PARENT
 * workflow survives verbatim. Recurses through objects and arrays.
 */
function rewriteInputMappingRefs(value: unknown, fragmentNodeIds: ReadonlySet<string>, prefix: string): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /(\$\{\s*nodes\.|\bnodes\.)([A-Za-z0-9_.-]+?)(\.)/g,
      (m, lead: string, id: string, dot: string) => (fragmentNodeIds.has(id) ? `${lead}${prefix}${id}${dot}` : m),
    );
  }
  if (Array.isArray(value)) return value.map((v) => rewriteInputMappingRefs(v, fragmentNodeIds, prefix));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteInputMappingRefs(v, fragmentNodeIds, prefix);
    }
    return out;
  }
  return value;
}

/** Stable, key-order-insensitive JSON for RFC 0157 §B policy comparison. The
 *  spec's rule is DEEP equality "key order insensitive", so `JSON.stringify`
 *  alone would report a conflict between two identical policies whose keys were
 *  authored in a different order. */
function canonicalPolicyJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalPolicyJson).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalPolicyJson(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function expandChain(chain: WorkflowChain, opts: ExpandOptions = {}): WorkflowDefinition {
  const deferred = opts.deferred === true;
  const providedParams = opts.params ?? {};
  const paramProps = ((chain.parameters as { properties?: Record<string, ChainParamSpec> }).properties) ?? {};
  const requiredParamNames = new Set(((chain.parameters as { required?: string[] }).required) ?? []);
  const sensitiveParams = new Set(
    Object.entries(paramProps).filter(([, s]) => s['x-openwop-sensitive'] === true).map(([n]) => n),
  );
  // RFC 0124 §Security — refuse before doing any work if a sensitive param would
  // be frozen (Path A, or a non-deferrable position in deferred mode). Fail closed.
  assertSensitiveDeferrable(chain, sensitiveParams, deferred);

  // Resolve each param to the value used for substitution / defaults. Path A
  // FREEZES these into config/inputs; deferred mode seeds `variables[].defaultValue`
  // from them (whole-value inputs tokens become variable PortValues instead). A
  // SENSITIVE param in deferred mode is NEVER persisted — no frozen value, no
  // default, no contribution to the id — so it stays out of `resolvedParams`.
  // (`{{params.*}}` whole-value tokens keep their JSON type, embedded tokens coerce
  // to string — the shared ADR 0237 / WCP2 rule in host/tokenSubstitution.)
  const resolvedParams: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(paramProps)) {
    if (deferred && sensitiveParams.has(name)) continue;
    const value = providedParams[name] !== undefined ? providedParams[name] : spec.default;
    if (value !== undefined) resolvedParams[name] = value;
  }
  // Fold the canonical resolved params into the id — freezing them into config
  // (or persisting them as variable defaults) means two param-sets MUST NOT
  // collide on the same workflowId (see above).
  const expansionId = deterministicExpansionId(chain, resolvedParams);
  const prefix = `${chain.chainId.replace(/\./g, '_')}_${expansionId}_`;
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

  // ── RFC 0157 §C — compensation checks, BEFORE any node is emitted ──
  //
  // Both refusals are fail-closed and precede node construction on purpose: a
  // half-expanded fragment whose compensator turns out to be a typo is exactly
  // the state RFC 0151 §B exists to prevent ("an unwind MUST NOT fail on a typo
  // first discovered during a failure — the worst possible moment to learn of
  // one"). Note step 6c is NOT gated on `opts.isTypeIdKnown`: the contradiction
  // is a property of the manifest, not of this host's registry.
  for (const n of chain.dag.nodes) {
    // 6c — an effect cannot both have and lack an inverse. The manifest schema
    // rejects the shape too (`if irreversibleEffect === true then not required
    // compensation`); expansion refuses rather than picking a side.
    if (n.irreversibleEffect === true && n.compensation !== undefined) {
      throw new OpenwopError(
        'chain_irreversible_with_compensation',
        `chain_irreversible_with_compensation: fragment node "${n.id}" in chain "${chain.chainId}" declares both `
          + 'irreversibleEffect: true and a compensation — an effect cannot both have and lack an inverse.',
        400,
        { chainId: chain.chainId, nodeId: n.id, retriable: false },
      );
    }
    // 3b — the compensator's `nodeTypeId` MUST resolve exactly as `typeId` does.
    if (n.compensation !== undefined && opts.isTypeIdKnown && !opts.isTypeIdKnown(n.compensation.nodeTypeId)) {
      throw new OpenwopError('validation_error', `chain_unresolvable_typeid: ${n.compensation.nodeTypeId}`, 400, {
        chainId: chain.chainId,
        nodeId: n.id,
        typeId: n.compensation.nodeTypeId,
      });
    }
  }

  const edges = chain.dag.edges ?? [];
  const hasOutgoing = new Set(edges.map((e) => parseRef(e.from).node));
  const terminalNodes = chain.dag.nodes.filter((n) => !hasOutgoing.has(n.id));
  const primaryNodeId = (terminalNodes[terminalNodes.length - 1] ?? chain.dag.nodes[chain.dag.nodes.length - 1])?.id;

  // Deferred mode (RFC 0124): a materialized variable name is collision-safe by
  // reusing the per-expansion prefix. A whole-value `{{params.x}}` top-level
  // `node.inputs` entry is rewritten to a variable-sourced PortValue that the
  // executor resolves per run from the bag (`{type:'variable', variableName}`).
  // Everything else (config, embedded/nested inputs) falls back to expansion-time
  // freeze — the spec-sanctioned §Rewrite-targets fallback (increment 1; the
  // prompt-body PromptTemplate lift that would defer config prompt tokens is a
  // follow-up). The §Security gate above guarantees no SENSITIVE param reaches a
  // frozen position, so a fallback-freeze here can never leak a secret.
  // Materialized-variable names must be `\w`-safe (`[a-zA-Z0-9_]`): they become
  // PromptTemplate `{{varName}}` placeholders, and the composer's placeholder regex
  // is `\{\{(\w+)\}\}` — a hyphen (which `slug` emits for `.`) would silently break
  // substitution. So the var prefix underscores the chain-id slug (the node-id
  // `prefix` keeps hyphens, which are valid there). Matches the RFC 0124 example
  // naming (`vendor_acme_generatePRD_a8f3_productIdea`).
  const varPrefix = `${chain.chainId.replace(/[.-]/g, '_')}_${expansionId}_`;
  const varNameOf = (p: string): string => `${varPrefix}${p}`;
  const WHOLE_PARAM = /^\{\{\s*params\.([a-zA-Z0-9_]+)\s*\}\}$/;
  const materializeInputs = (inputs: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [port, val] of Object.entries(inputs)) {
      const m = typeof val === 'string' ? WHOLE_PARAM.exec(val) : null;
      out[port] = m && paramProps[m[1]]
        ? { type: 'variable', variableName: varNameOf(m[1]) }
        // ADR 0616 — the fallback FREEZES, so it must mark a missing required param
        // exactly as non-deferred does. Deferred mode defers whole-value tokens and
        // liftable prompt bodies; everything reaching here is frozen and can never
        // receive a run-time value, so an unmarked `''` is silently wrong.
        : substituteTokensDeep(val, 'params', resolvedParams, requiredParamNames);
    }
    return out;
  };

  // ── RFC 0124 G3 — inline-prompt-body lift (deferred mode) ──
  // An inline `config.systemPrompt`/`userPrompt` carrying `{{params.x}}` has no
  // portable runtime interpolation surface. Deferred mode lifts it into a MINTED,
  // deterministic host PromptTemplate whose `text` holds a `{{varName}}` slot
  // (`source:"variable"`) and points the node's `*PromptRef` at it — so a prompt
  // param defers portably, and a SENSITIVE param can reach a prompt safely (redacted
  // at compose, never frozen). Non-prompt config still freezes (Path-A fallback).
  const paramTokenRe = (): RegExp => /\{\{\s*params\.([a-zA-Z0-9_]+)\s*\}\}/g;
  const bodyHasKnownParam = (body: string): boolean => {
    for (const m of body.matchAll(paramTokenRe())) if (paramProps[m[1]]) return true;
    return false;
  };
  const mintedTemplates: PromptTemplate[] = [];
  const liftPromptBody = (nodeId: string, kind: PromptTemplate['kind'], body: string): { templateId: string; version: string } => {
    const refs = new Set<string>();
    const text = body.replace(paramTokenRe(), (m, name: string) => {
      if (!paramProps[name]) return m;
      refs.add(name);
      return `{{${varNameOf(name)}}}`;
    });
    const version = '1.0.0';
    const templateId = `chainmint-${expansionId}-${slug(nodeId).toLowerCase()}-${kind}`;
    const template: PromptTemplate = {
      templateId,
      version,
      kind,
      text,
      name: `${chain.chainId}:${nodeId}:${kind} (deferred)`,
      variables: [...refs].map((name) => {
        const spec = paramProps[name];
        const isSensitive = sensitiveParams.has(name);
        // RFC 0124 §Security amendment (2026-07-04) — a `sensitive` param materializes
        // as a `source:"secret"` PromptVariable: its per-run supply is a BYOK secret
        // reference (credentialRef) resolved from the host secret store, emitted as
        // `[REDACTED:<secretId>]` in observability and NEVER carried as a plaintext
        // `source:"variable"` value (which would leak via the run bag / RunSnapshot /
        // at-rest). Non-sensitive params stay `source:"variable"` (overridable plaintext).
        return {
          name: varNameOf(name),
          type: (typeof spec.type === 'string' ? spec.type : 'string') as NonNullable<PromptTemplate['variables']>[number]['type'],
          required: requiredParamNames.has(name) || isSensitive,
          source: (isSensitive ? 'secret' : 'variable') as 'secret' | 'variable',
          ...(isSensitive ? { sensitive: true } : {}),
        };
      }),
    };
    registerMintedTemplate(template);
    mintedTemplates.push(template);
    return { templateId, version };
  };
  const deferredConfig = (nodeId: string, config: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(config)) {
      const pb = LIFTABLE_PROMPT_BODY_KEYS[key];
      if (pb && typeof val === 'string' && bodyHasKnownParam(val)) {
        out[pb.refKey] = liftPromptBody(nodeId, pb.kind, val); // lift → *PromptRef
      } else {
        // ADR 0616 — same as `materializeInputs`: a non-liftable config key is
        // frozen here, so it needs the CHAIN-EMBED-1 marker too. Without it
        // `config.key: "seen:{{params.feedUrl}}"` froze to `"seen:"` — a SHARED
        // KV key across every deferred instantiation, not merely a degraded one.
        out[key] = substituteTokensDeep(val, 'params', resolvedParams, requiredParamNames); // freeze (fallback)
      }
    }
    return out;
  };

  // ADR 0502 §Open-1 / ADR 0504 — record every WHOLE-VALUE `{{params.NAME}}`
  // token whose param has no value. `resolveTokenString` returns `bag[NAME]`
  // for a whole-value token, so an absent param freezes to `undefined` and the
  // key then VANISHES from the minted node entirely (JSON drops it).
  //
  // That vanishing is why nothing caught this: the ADR 0498 check inspects the
  // MINTED node and sees a key that simply is not there, indistinguishable from
  // a key the author never wrote. Only here, holding the authored token AND the
  // params, is the difference knowable.
  //
  // Verified live 2026-07-29: instantiating the Challenge Factory with no params
  // minted a persisted, gallery-visible workflow whose search node had no
  // `query`. Every run of it failed with "core.web.search requires a non-empty
  // `query` input" — an error naming an internal node, never the missing
  // parameter. This is what makes that diagnosable.
  const unresolvedParams: UnfilledParamFinding[] = [];
  const collectUnresolved = (nodeId: string, authored: unknown, path: string): void => {
    if (typeof authored === 'string') {
      const m = /^\{\{\s*params\.([a-zA-Z0-9_]+)\s*\}\}$/.exec(authored);
      if (m) {
        if (resolvedParams[m[1]!] === undefined) {
          unresolvedParams.push({ nodeId, key: path, param: m[1]! });
        }
        return;
      }
      // ADR 0507 — the EMBEDDED case, which ADR 0504 §Open-2 left uncovered and
      // which is STRICTLY MORE DANGEROUS than the whole-value one.
      //
      // A whole-value token freezes to `undefined`, the key vanishes, and the node
      // fails loudly ("requires a non-empty `query`"). An EMBEDDED token
      // (`"…Invoice: {{params.invoiceText}}"`) freezes to `''` — a perfectly valid
      // string — so nothing fails. `finance.invoice-ap` ships
      // `"Extract vendor, line items, amounts, and totals from the invoice.
      // Invoice: {{params.invoiceText}}"`; instantiated without the param it asks a
      // model to extract line items from NOTHING, the model obliges, and the
      // fabrication flows to an approval gate. Measured 2026-08-01: 36 chains carry
      // this (12 exclusively), including invoice extraction, PR review, email
      // triage and document summarisation — all "read this text" prompts whose text
      // silently disappears.
      //
      // Recorded with `embedded: true` so a consumer can rank it: absent input that
      // FAILS is a bug; absent input that SUCCEEDS with invented content is worse.
      let em: RegExpExecArray | null;
      const re = /\{\{\s*params\.([a-zA-Z0-9_]+)\s*\}\}/g;
      while ((em = re.exec(authored)) !== null) {
        if (resolvedParams[em[1]!] === undefined) {
          unresolvedParams.push({ nodeId, key: path, param: em[1]!, embedded: true });
        }
      }
      return;
    }
    if (Array.isArray(authored)) {
      authored.forEach((v, i) => collectUnresolved(nodeId, v, `${path}[${i}]`));
      return;
    }
    if (authored && typeof authored === 'object') {
      for (const [k, v] of Object.entries(authored as Record<string, unknown>)) {
        collectUnresolved(nodeId, v, path ? `${path}.${k}` : k);
      }
    }
  };
  if (!deferred) {
    // Deferred mode materializes params as run-overridable variables instead of
    // freezing them, so an absent value there is expected, not a failed freeze.
    for (const n of chain.dag.nodes) {
      collectUnresolved(rewrite(n.id), n.config, '');
      collectUnresolved(rewrite(n.id), n.inputs, '');
    }
  }

  // RFC 0157 steps 5b + 6b — the compensator's `inputMapping` gets the SAME two
  // transforms the node's own `config`/`inputs` get: `{{params.*}}` frozen at
  // author time, then fragment node-id references re-prefixed. Both modes: an
  // `inputMapping` is a recorded-facts read, not a run-overridable input, so
  // deferred mode has nothing extra to do here (RFC 0157 UQ1 — deferral of
  // `inputMapping` tokens is explicitly DEFERRED, frozen at drop time).
  const fragmentNodeIds = new Set(chain.dag.nodes.map((n) => n.id));
  const carryCompensation = (c: FragmentNodeCompensation): FragmentNodeCompensation => ({
    nodeTypeId: c.nodeTypeId,
    ...(c.inputMapping !== undefined
      ? {
          inputMapping: rewriteInputMappingRefs(
            substituteTokensDeep(c.inputMapping, 'params', resolvedParams, requiredParamNames),
            fragmentNodeIds,
            prefix,
          ) as Record<string, unknown>,
        }
      : {}),
    ...(c.retry !== undefined ? { retry: { ...c.retry } } : {}),
    ...(c.requiresApproval !== undefined ? { requiresApproval: c.requiresApproval } : {}),
    // RFC 0151 §B (S36). A field absent from THIS allowlist is not rejected —
    // it is silently discarded, which is #3292 exactly.
    ...(c.waiveRequiresApproval !== undefined ? { waiveRequiresApproval: c.waiveRequiresApproval } : {}),
  });

  const nodes = chain.dag.nodes.map((n) => ({
    nodeId: rewrite(n.id),
    typeId: n.typeId,
    ...(n.config
      ? {
          config: (deferred
            ? deferredConfig(n.id, n.config as Record<string, unknown>)
            : substituteTokensDeep(n.config, 'params', resolvedParams, requiredParamNames)) as Record<string, unknown>,
        }
      : {}),
    ...(n.inputs
      ? {
          inputs: (deferred
            ? materializeInputs(n.inputs as Record<string, unknown>)
            : substituteTokensDeep(n.inputs, 'params', resolvedParams, requiredParamNames)) as Record<string, unknown>,
        }
      : {}),
    ...(n.id === primaryNodeId ? { outputRole: 'primary' as const } : {}),
    // RFC 0157 §A / step 5b+6b — the inverse-action declaration survives
    // expansion. This host previously rebuilt the expanded node from an
    // allowlist that did not name it, so a chain-authored compensator was
    // discarded here and again in `validateWorkflowDefinition` — and on a host
    // where every workflow is a chain, that made RFC 0151 §B unreachable.
    ...(n.compensation ? { compensation: carryCompensation(n.compensation) } : {}),
    // RFC 0151 §B UQ4 / step 6c — copied UNCHANGED. Its value carries a real
    // §D consequence (the plan records the node `irreversible` so the rollup
    // caps at `partial`), so dropping it here would let a rollup claim a full
    // undo for a run that committed an effect with no inverse.
    ...(n.irreversibleEffect !== undefined ? { irreversibleEffect: n.irreversibleEffect } : {}),
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
      // ADR 0201 — carry the fragment's edge condition through to the expanded
      // WorkflowDefinition, mapped from the wire EdgeCondition shape to the
      // host executor's {path,op,value}. This is what lets a chain express
      // content routing (router/switch/conditional branches).
      ...(e.condition ? { condition: mapEdgeCondition(e.condition, `${from.node}→${to.node}`) } : {}),
      // RFC 0125 — carry the fragment's fan-in rule through VERBATIM (expansion MUST
      // preserve `triggerRule`; §"Expansion semantics" step 6). No mapping: the wire
      // enum IS `EdgeDef['triggerRule']`. This is what lets a chain express error-
      // routing / best-effort completion (e.g. an `all_complete` terminal so a failed
      // upstream still completes the run — ADR 0247 OQ-2). The expanded WorkflowEdge is
      // then validated + scheduled exactly like a hand-authored one.
      ...(e.triggerRule ? { triggerRule: e.triggerRule } : {}),
    };
  });

  // Deferred mode (RFC 0124): materialize chain params → run-overridable
  // `variables[]` + a `configurableSchema` bare-param ALIAS so run-time callers
  // pass the bare name (`productIdea`), mapped to the collision-safe prefixed
  // variable. A SENSITIVE param becomes `required` with NO persisted defaultValue
  // (SR-1 at-rest) — its value is supplied per run. Path A emits neither (values
  // are frozen into config/inputs, kept distinct so the two modes don't blur).
  let variables: WorkflowDefinition['variables'];
  let configurableSchema: Record<string, unknown> | undefined;
  let deferredAliases: Record<string, string> | undefined;
  if (deferred) {
    variables = Object.entries(paramProps).map(([name, spec]) => {
      const isSensitive = sensitiveParams.has(name);
      return {
        name: varNameOf(name),
        ...(typeof spec.type === 'string' ? { type: spec.type } : {}),
        ...(spec.description ? { description: spec.description } : {}),
        // RFC 0136 requirement 7 — copy a STRING parameter's `format` verbatim onto
        // the materialized WorkflowVariable (req 1: string-typed only; req 2:
        // unvalidated, an unknown value is still copied; req 6: composes with
        // `sensitive`, no interaction). It is NOT propagated into `configurableSchema`
        // below (req 8) — that surface validates and would make `format` an assertion.
        ...(spec.type === 'string' && typeof spec.format === 'string' ? { format: spec.format } : {}),
        required: requiredParamNames.has(name) || isSensitive,
        ...(isSensitive ? { sensitive: true } : {}),
        ...(!isSensitive && resolvedParams[name] !== undefined ? { defaultValue: resolvedParams[name] } : {}),
      };
    });
    // `configurableSchema` is a REAL JSON Schema (used by `POST /v1/runs`
    // run-options validation) keyed by the BARE param name — the run-time
    // override key (RFC 0124 G1). The bare→prefixed-variable mapping lives in
    // `metadata.deferredParameterAliases` (below); run-creation reads it to seed
    // the variable bag from a `configurable` override (host/variablesRuntime).
    const props: Record<string, unknown> = {};
    const aliases: Record<string, string> = {};
    for (const [name, spec] of Object.entries(paramProps)) {
      props[name] = typeof spec.type === 'string' ? { type: spec.type } : {};
      aliases[name] = varNameOf(name);
    }
    configurableSchema = { type: 'object', properties: props };
    deferredAliases = aliases;
  }

  // RFC 0133 §2 — merge run-PRODUCED variables (a value a node writes to the run
  // bag during the run, read downstream by name). Applies in BOTH Path-A and
  // deferred mode — these are NOT author-time params. Run-scoped: name + type
  // only, NO `defaultValue` (SR-1 at-rest guard) and `required:false` (the run
  // produces them; they are not a required input). Their bag name is used
  // VERBATIM (no `varNameOf` prefix): the producing/consuming nodes address the
  // exact declared name (`{type:'variable',variableName}`), so a prefix would
  // break the read/write. Load-time validation (loadWorkflowChainPacks) has
  // already asserted every `{type:'variable'}` read resolves to one of these or a
  // param, and that these names don't collide with a param variable.
  if (chain.producedVariables?.length) {
    const produced: NonNullable<WorkflowDefinition['variables']> = chain.producedVariables.map((pv) => ({
      name: pv.name,
      type: pv.type,
      required: false,
      ...(pv.description ? { description: pv.description } : {}),
    }));
    variables = [...(variables ?? []), ...produced];
  }

  // ── RFC 0157 §B / expansion step 9b — the chain-level POLICY ──
  //
  //   parent has none          ⇒ COPY the chain's;
  //   parent has a deep-equal  ⇒ ACCEPT (key order insensitive);
  //   parent has a different   ⇒ `chain_compensation_policy_conflict` (409).
  //
  // NEVER merged. A merged policy nobody wrote is exactly the guess-at-a-contract
  // failure the policy exists to prevent; the author reconciles and re-expands.
  // A chain declaring none INHERITS the parent's (or none) — silence is not a
  // policy of "no compensation".
  //
  // RFC 0157 UQ2 (resolved for v1): a SUB-CHAIN's policy is not weighed against
  // its parent's — each co-registered workflow owns its own `settings`, so
  // `coRegisterSubChains` expands the child with no parent policy and the child's
  // definition carries the child's own. A parent–child difference is not a conflict.
  //
  // The capability gate is deliberately NOT re-implemented here: the definition
  // goes through `validateWorkflowDefinition` → `checkCompensationPolicy` below,
  // which is the ONE authority that refuses `settings.compensation` with
  // `capability_required` on a host that does not advertise the family, and that
  // validates `orderingModel`/`profileVersion` against the ADVERTISED set at
  // registration. Duplicating it would be a second answer that could drift.
  let settingsCompensation: CompensationPolicy | undefined = opts.parentSettingsCompensation;
  if (chain.compensation !== undefined) {
    if (opts.parentSettingsCompensation === undefined) {
      settingsCompensation = { ...chain.compensation, triggers: [...chain.compensation.triggers] };
    } else if (canonicalPolicyJson(opts.parentSettingsCompensation) !== canonicalPolicyJson(chain.compensation)) {
      throw new OpenwopError(
        'chain_compensation_policy_conflict',
        `chain_compensation_policy_conflict: chain "${chain.chainId}" declares a compensation policy that differs `
          + "from the parent workflow's settings.compensation; expansion MUST NOT merge policies.",
        409,
        { chainId: chain.chainId, retriable: false },
      );
    }
  }

  const definition: WorkflowDefinition = {
    workflowId: `${chain.chainId}:${expansionId}`,
    nodes,
    edges: mappedEdges,
    ...(settingsCompensation ? { settings: { compensation: settingsCompensation } } : {}),
    ...(variables && variables.length ? { variables } : {}),
    ...(configurableSchema ? { configurableSchema } : {}),
    metadata: {
      name: chain.label,
      purpose: chain.description,
      source: 'workflow-chain-pack',
      chainId: chain.chainId,
      chainVersion: chain.version,
      expansionId,
      // RFC 0124 — which expansion mode produced this definition.
      expansionMode: deferred ? 'deferred' : 'expansion-time',
      // RFC 0124 G1 — bare chain-param name → prefixed materialized-variable name.
      // Run-creation maps a `configurable` override (keyed by the bare name) onto
      // the variable bag through this alias (host/variablesRuntime).
      ...(deferredAliases ? { deferredParameterAliases: deferredAliases } : {}),
      // RFC 0124 G3 — the PromptTemplates minted by the inline-prompt-body lift.
      // Carried on the definition so it is self-contained: a host loading this
      // workflow re-registers them (host/promptStore.registerMintedTemplate) so the
      // `*PromptRef`s resolve even across a process restart / on a different host.
      ...(mintedTemplates.length ? { mintedPromptTemplates: mintedTemplates } : {}),
      // Re-parameterization anchor (RFC 0013 §expansion): re-expand this chain
      // with new params to get a fresh definition. Carries the exact
      // (chainId, version, params) this definition was expanded from. In deferred
      // mode `params` excludes sensitive params (never persisted).
      expandedFrom: { chainId: chain.chainId, version: chain.version, params: resolvedParams },
      // ADR 0504 — the params that did NOT freeze. Minting still succeeds:
      // "Use template = just copy" is a documented contract and refusing here is
      // what the ADR 0498 enforcement revert established would break.
      //
      // CORRECTED (ADR 0676 D4) — this used to continue: "Run START re-checks these
      // against the CURRENT node (see `runs.ts`)." It does NOT. `routes/runs.ts:281-283`
      // records that the run-start REFUSAL was built and deliberately NOT shipped
      // (ADR 0504: measured first, `seedWorkflows.ts` expands every chain with `{}`, so
      // 114 of 169 seeded chains carry unfilled required params). NOTHING re-checks at
      // start. Filling the blank in the builder still clears the block without touching
      // this record — that half was always true — but a reader must not infer a run-time
      // safety net that does not exist. Grep note: the old claim wrapped across two source
      // lines, so `git grep 'Run START re-checks'` returned nothing and it read as already
      // fixed; that is why it survived two passes.
      ...(unresolvedParams.length ? { unresolvedParams } : {}),
      ...(chain.capabilities ? { capabilities: chain.capabilities } : {}),
      ...(chain.outputs ? { outputs: chain.outputs } : {}),
    },
  };

  // R8 — the expanded graph is validated exactly like any authored workflow.
  // P2 — REPORT-ONLY missing-required-config check, on the definition ACTUALLY
  // MINTED (grade-code HIGH-1 / grade-data GATE-1, measured independently by
  // both): the pre-expansion form counted 40 nodes conformant that expansion
  // then emptied, so the ratchet read 125→6 while real undefined-frozen config
  // keys went 63→98. Checking the authored chain measured the wrong artifact.
  //
  // Still a report, not a throw: "Use template = just copy" is a documented
  // contract, so refusing here would break copying a template with blanks.
  if (opts.requiredConfigKeysFor) {
    for (const f of findMissingRequiredConfig(definition.nodes, opts.requiredConfigKeysFor, chain.chainId)) {
      log.warn('chain_node_missing_required_config', { chainId: f.chainId, nodeId: f.nodeId, typeId: f.typeId, missing: f.missing });
    }
  }

  return validateWorkflowDefinition(definition);
}

/** RFC 0133 §1 — the max sub-chain nesting depth the host will co-register. */
export const MAX_SUB_CHAIN_DEPTH = 8;

/** A typed error the from-chain route maps to the wire (`sub_chain_*`). */
export class SubChainError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'SubChainError'; }
}

/** Injected side-effects so the loader stays decoupled from the registry/ownership
 *  modules (the route provides the real `registerWorkflow` + `recordOwnership`). */
export interface SubChainDeps {
  register: (def: WorkflowDefinition) => void;
  own: (workflowId: string, name: string, nodeCount: number) => Promise<void>;
  /** RFC 0133 §1.3 — false ⇒ this host has no runtime child dispatch; refuse
   *  (`sub_chain_unsupported`) rather than silently flatten. openwop-app = true
   *  (env `OPENWOP_CHAIN_SUBCHAINS=0` flips it off to witness the negative scenario). */
  supported: boolean;
  /** Optional resolver for an EXTERNAL `{packName,chainId,version}` ref; sibling
   *  refs resolve via the in-process chain registry (`getChain`). */
  resolveExternal?: (ref: { packName: string; chainId: string; version: string }) => WorkflowChain | null;
}

/** RFC 0133 §1.3 step 2 — the deterministic, TENANT-SCOPED, version-pinned,
 *  convergent child workflow id, keyed on exactly `(tenantId, childChainId, version)`.
 *  Tenant-scoped by construction because `registerWorkflow` is a GLOBAL by-id
 *  registry: a tenant-less id would let two tenants instantiating the same
 *  parent→child collide on one global workflow (a cross-tenant isolation break —
 *  SECURITY `sub-chain-child-tenant-scoped`). Keying on `tenantId` also makes the
 *  dedup correct ACROSS PARENTS in a tenant (a child composed by two parents
 *  registers once) and a repeat instantiation converge (idempotent overwrite);
 *  `version` distinguishes `child@1` from `child@2`. The exact string shape is NOT
 *  wire-normative (the spec pins only the keying + determinism + tenant-scope — its
 *  own reference uses a readable `wfc_…` form); this host keeps its collision-safe
 *  hash form, surfaced verbatim in the `subChainWorkflowIds[]` response. */
export function mintChildWorkflowId(tenantId: string, childChainId: string, version: string): string {
  const h = createHash('sha256').update(`${tenantId}\0${childChainId}@${version}`).digest('hex').slice(0, 12);
  return `wf.${slug(childChainId)}.sc-${h}`;
}

function resolveSubChainRef(ref: string, chain: WorkflowChain, deps: SubChainDeps): WorkflowChain | null {
  // Sibling: a string ref → a declared subChains sibling chainId → the registry.
  const found = getChain(ref);
  if (found) return found.chain;
  // External: the declared subChains entry for this ref carries {packName,chainId,version}.
  const ext = (chain.subChains ?? []).map((s) => s.ref).find((r) => typeof r === 'object' && r.chainId === ref);
  if (ext && typeof ext === 'object' && deps.resolveExternal) return deps.resolveExternal(ext);
  return null;
}

/**
 * RFC 0133 §1.3 — expand a chain AND co-register its sub-chains, returning the
 * parent definition with each `config.subChainRef` rewritten to the minted child
 * workflow id, plus the ids co-registered. Children are registered DEPTH-FIRST and
 * BEFORE the parent, so the parent's rewritten `config.workflowId` always resolves
 * and a mid-way failure leaves at worst a harmless unreferenced child (never a
 * parent pointing at a missing child). Cycle- + depth-guarded.
 */
export async function coRegisterSubChains(
  chain: WorkflowChain,
  opts: { params: Record<string, unknown>; deferred?: boolean; tenantId: string; requiredConfigKeysFor?: (typeId: string) => readonly string[] },
  deps: SubChainDeps,
  depth = 0,
  visited: ReadonlySet<string> = new Set(),
): Promise<{ definition: WorkflowDefinition; registeredChildIds: string[] }> {
  // RFC 0133 §1.3 — a host WITHOUT runtime child dispatch MUST refuse a
  // subChains-bearing chain (`sub_chain_unsupported`, 422) rather than silently
  // flatten (flattening erases the child as an editable unit + changes run
  // semantics). Refuse UP FRONT — before expansion — the moment the chain declares
  // sub-chains, so the refusal doesn't depend on a referencing node surviving
  // expansion. Only the ROOT declaration matters here; nested children are reached
  // only when supported, so this is checked once at depth 0.
  if (!deps.supported && chain.subChains?.length) {
    throw new SubChainError('sub_chain_unsupported', 'this host does not support runtime child dispatch (sub-chains)');
  }

  const definition = expandChain(chain, {
    params: opts.params,
    ...(opts.deferred ? { deferred: true } : {}),
    ...(opts.requiredConfigKeysFor ? { requiredConfigKeysFor: opts.requiredConfigKeysFor } : {}),
  });
  const nodesWithRef = definition.nodes.filter((n) => typeof (n.config as Record<string, unknown> | undefined)?.subChainRef === 'string');
  if (nodesWithRef.length === 0) return { definition, registeredChildIds: [] };

  if (depth > MAX_SUB_CHAIN_DEPTH) {
    throw new SubChainError('sub_chain_max_depth_exceeded', `sub-chain nesting exceeds maxSubChainDepth (${MAX_SUB_CHAIN_DEPTH})`);
  }
  if (visited.has(chain.chainId)) {
    throw new SubChainError('sub_chain_cycle', `sub-chain cycle re-entering ${chain.chainId}`);
  }
  const nextVisited = new Set(visited).add(chain.chainId);

  const registeredChildIds: string[] = [];
  const refToChildId = new Map<string, string>();
  for (const node of nodesWithRef) {
    const ref = String((node.config as Record<string, unknown>).subChainRef);
    if (!refToChildId.has(ref)) {
      const childChain = resolveSubChainRef(ref, chain, deps);
      if (!childChain) throw new SubChainError('sub_chain_unresolved', `sub-chain ref "${ref}" could not be resolved`);
      // Recurse FIRST (grandchildren register before this child), then this child.
      const childId = mintChildWorkflowId(opts.tenantId, childChain.chainId, childChain.version);
      // §Correction (code-review HIGH #3) — carry the config REPORT into children.
    // "Workflows nest" is first-class here, so a child is exactly where an
    // unnoticed expansion recurs. Children expand with `params: {}` BY DESIGN
    // (their values arrive at dispatch from the parent), so this stays a report.
    const nested = await coRegisterSubChains(
      childChain,
      { params: {}, tenantId: opts.tenantId, ...(opts.requiredConfigKeysFor ? { requiredConfigKeysFor: opts.requiredConfigKeysFor } : {}) },
      deps, depth + 1, nextVisited,
    );
      // RFC 0133 §1.3 (F3 fix, ADR 0472 P4) — a sub-chain child receives its inputs from
      // the parent's `core.subWorkflow` inputMapping, seeded into the child run's variable
      // bag at DISPATCH. The executor's `seedRunVariables` only seeds DECLARED variables
      // (KTFULL-B4), and Path-A `expandChain` emits none for a chain's `parameters` — so
      // without this the child's dispatch-seeded inputs (`days`, `candidateId`, …) resolve
      // to `undefined` and the child never runs. Emit each declared child parameter as a
      // run-scoped variable declaration (name + type, `required:false`, NO defaultValue —
      // dispatch-seeded, not author-frozen; the SR-1 at-rest guard), deduped against any
      // produced variables the child already emitted.
      const childParamProps = (childChain.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {};
      const already = new Set((nested.definition.variables ?? []).map((v) => v.name));
      const childInputVars = Object.entries(childParamProps)
        .filter(([name]) => !already.has(name))
        .map(([name, schema]) => ({ name, type: schema.type ?? 'string', required: false }));
      const childDef: WorkflowDefinition = {
        ...nested.definition,
        workflowId: childId,
        variables: [...(nested.definition.variables ?? []), ...childInputVars],
      };
      deps.register(childDef);                                    // child BEFORE parent
      const childName = typeof childDef.metadata?.name === 'string' ? childDef.metadata.name : childChain.label;
      await deps.own(childId, childName, childDef.nodes.length);
      registeredChildIds.push(...nested.registeredChildIds, childId);
      refToChildId.set(ref, childId);
    }
  }
  // Rewrite every referencing node: config.subChainRef → config.workflowId (the
  // field core.subWorkflow / core.dispatch read at runtime).
  const rewritten = definition.nodes.map((n) => {
    const cfg = n.config as Record<string, unknown> | undefined;
    const ref = cfg && typeof cfg.subChainRef === 'string' ? (cfg.subChainRef as string) : undefined;
    if (!ref || !cfg) return n;
    const rest: Record<string, unknown> = { ...cfg };
    delete rest.subChainRef;
    return { ...n, config: { ...rest, workflowId: refToChildId.get(ref) } };
  });
  return { definition: { ...definition, nodes: rewritten }, registeredChildIds: [...new Set(registeredChildIds)] };
}
