
import { declaration } from './specDeclaration.js';

/**
 * RFC 0177 §A.1 / §B.1 — the two install-time refusals `spec/v2/core/packs.md`
 * requires of a major-2 host.
 *
 * WHY THIS IS ONE MODULE AND NOT A CHECK IN THE PUBLISH HANDLER. packs.md §"The
 * engine range" ends with a completeness clause that is easy to skim past:
 *
 *   > The check MUST run at install on EVERY publication path — the canonical
 *   > registry, a vendor registry's write API, and a mirror ingest — so no
 *   > registry-side artifact can bypass it.
 *
 * A per-handler check satisfies the scenario the suite can drive and leaves the
 * other paths open, which is the shape this repo keeps finding: a gate on one
 * lane is not a gate on the concept. So the rule lives here and every publish
 * path calls it.
 */

/** Grammar from `schemas/v2/node-pack-manifest.schema.json`, quoted in packs.md §"The engine range". */
const RANGE_RE = /^>=(\d+)(?:\.\d+){0,2}\s+<(\d+)\.0\.0$/;
/** A lower bound with NO ceiling — legal input, but see `impliedCeiling`. */
const UNBOUNDED_RE = /^>=(\d+)(?:\.\d+){0,2}$/;

export type PackManifestRefusal =
  | { code: 'pack_engine_unsupported'; message: string }
  | { code: 'pack_peer_dependency_undefined'; message: string }
  | { code: 'validation_error'; message: string };

/** Exact SemVer, including the optional prerelease/build suffixes. */
const EXACT_SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function workflowChainPinRefusal(manifest: Record<string, unknown>): PackManifestRefusal | null {
  if (manifest['kind'] !== 'workflow-chain') return null;
  const chains = manifest['chains'];
  if (!Array.isArray(chains)) return null; // structural schema validation owns this shape

  for (const chain of chains) {
    if (chain === null || typeof chain !== 'object' || Array.isArray(chain)) continue;
    const c = chain as Record<string, unknown>;
    const dag = c['dag'];
    const nodes = dag !== null && typeof dag === 'object' && !Array.isArray(dag)
      ? (dag as Record<string, unknown>)['nodes']
      : undefined;
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
        const typeId = (node as Record<string, unknown>)['typeId'];
        if (typeof typeId !== 'string') continue;
        const at = typeId.lastIndexOf('@');
        const version = at > 0 ? typeId.slice(at + 1) : '';
        if (!EXACT_SEMVER_RE.test(version)) {
          return {
            code: 'validation_error',
            message: `workflow-chain node typeId "${typeId}" MUST end in an exact SemVer pin (for example @1.0.0); ranges and unpinned references are forbidden (spec/v2/core/workflow-chain-packs.md §"Exact pins")`,
          };
        }
      }
    }

    const subChains = c['subChains'];
    if (!Array.isArray(subChains)) continue;
    for (const subChain of subChains) {
      if (subChain === null || typeof subChain !== 'object' || Array.isArray(subChain)) continue;
      const ref = (subChain as Record<string, unknown>)['ref'];
      if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) continue;
      const version = (ref as Record<string, unknown>)['version'];
      if (typeof version === 'string' && !EXACT_SEMVER_RE.test(version)) {
        return {
          code: 'validation_error',
          message: `workflow-chain external sub-chain version "${version}" MUST be an exact SemVer pin; ranges are forbidden (spec/v2/core/workflow-chain-packs.md §"Exact pins")`,
        };
      }
    }
  }
  return null;
}

let declaredFamilies: ReadonlySet<string> | undefined;

/**
 * The peer-dependency identifier set, read from the VENDORED
 * `schemas/v2/declaration.json`.
 *
 * NOT derived from `capabilities.schema.json`'s property names, which is the
 * obvious substitute and is WRONG: MEASURED, the schema carries 88 properties
 * against the declaration's 86 families, so a host validating against it would
 * accept and reject the wrong keys while looking principled.
 */
export function declaredPeerDependencyKeys(): ReadonlySet<string> {
  if (declaredFamilies) return declaredFamilies;
  // Reads through `host/specDeclaration.ts`, the single owner of this file
  // (ADR 0687 § Finding 2) — this used to be a third independent load, with its
  // own `locateRepoSchemasDir` sentinel and its own cache. The loud-fail below
  // is the original and is the behaviour the shared reader copied, not the
  // reverse.
  const keys = (declaration().families ?? [])
    .map((f) => (typeof f.key === 'string' ? f.key : ''))
    .filter((k) => k.length > 0);
  if (keys.length === 0) {
    // Fail LOUD. An empty set would make every peer dependency undefined and
    // refuse every pack — the opposite failure, but still a silent one if it
    // were allowed to read as "nothing declared".
    throw new Error('spec/v2/declaration.json carried no families[].key — the peer-dependency identifier set is unreadable');
  }
  declaredFamilies = new Set(keys);
  return declaredFamilies;
}

/**
 * Does `range` admit protocol major `hostMajor`?
 *
 * The rule that is NOT semver-obvious, and is the whole point of the leg:
 * ">=1.0.0" with no ceiling reads as `<2.0.0` on a v2 host. Under plain semver
 * an unbounded `>=1.0.0` includes 2.x, so a host that just ran a semver
 * satisfies() would ACCEPT the pack the spec says to refuse. packs.md: "A v2
 * host MUST treat a range with no upper bound as bounded by `<2.0.0`."
 */
export function rangeAdmitsMajor(range: string, hostMajor: number): boolean {
  const trimmed = range.trim();
  const bounded = RANGE_RE.exec(trimmed);
  if (bounded) {
    const lower = Number(bounded[1]);
    const ceiling = Number(bounded[2]);
    return lower <= hostMajor && hostMajor < ceiling;
  }
  const unbounded = UNBOUNDED_RE.exec(trimmed);
  if (unbounded) {
    const lower = Number(unbounded[1]);
    // The implied `<2.0.0` ceiling.
    return lower <= hostMajor && hostMajor < 2;
  }
  // Neither shape: the range does not match the manifest grammar, so it cannot
  // be shown to admit this major. Refuse rather than guess — an unparseable
  // range that installs is how a v1-only pack reaches a v2 runtime.
  return false;
}

/**
 * Validate a node-pack manifest at install for a major-`hostMajor` host.
 * Returns the refusal to answer with, or `null` when the manifest is admissible.
 */
export function checkPackManifestForMajor(manifest: unknown, hostMajor: number): PackManifestRefusal | null {
  const m = (manifest ?? {}) as Record<string, unknown>;

  const engines = (m['engines'] ?? {}) as Record<string, unknown>;
  const range = engines['openwop'];
  if (typeof range !== 'string' || range.trim().length === 0) {
    return {
      code: 'pack_engine_unsupported',
      message: 'engines.openwop is REQUIRED and MUST declare a range admitting the host protocol major '
        + `${hostMajor} (spec/v2/core/packs.md §"The engine range")`,
    };
  }
  if (!rangeAdmitsMajor(range, hostMajor)) {
    return {
      code: 'pack_engine_unsupported',
      // Name the implied ceiling explicitly: "«>=1.0.0» does not admit 2" reads
      // as a bug report against the host unless the reader knows the rule.
      message: `engines.openwop "${range}" does not admit protocol major ${hostMajor}`
        + (UNBOUNDED_RE.test(range.trim()) ? ' — a range with no upper bound is read as bounded by <2.0.0' : '')
        + ' (spec/v2/core/packs.md §"The engine range")',
    };
  }

  const peers = m['peerDependencies'];
  if (peers !== undefined) {
    if (typeof peers !== 'object' || peers === null || Array.isArray(peers)) {
      return { code: 'pack_peer_dependency_undefined', message: 'peerDependencies MUST be an object keyed by capability family' };
    }
    const declared = declaredPeerDependencyKeys();
    for (const key of Object.keys(peers as Record<string, unknown>)) {
      if (!declared.has(key)) {
        return {
          code: 'pack_peer_dependency_undefined',
          message: `peerDependencies key "${key}" is not a family named by spec/v2/declaration.json `
            + '(spec/v2/core/packs.md §"Peer-dependency identifiers"). Facet paths are not identifiers — '
            + 'require the family by its key and name facets in peerDependenciesMeta.<family>.facets[].',
        };
      }
    }
  }

  return workflowChainPinRefusal(m);
}
