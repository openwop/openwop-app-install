/**
 * ADR 0766 — the ONE owner of the RFC 0177 §E.1 exact-pin rule for workflow-chain
 * references (`spec/v2/core/workflow-chain-packs.md` §"Exact pins"):
 *
 *   > Every reference a chain makes to a node type MUST pin an exact version per
 *   > referenced `typeId` (`core.ai.callPrompt@1.0.0`). A host MUST refuse to
 *   > register a chain whose reference carries a range or no version.
 *
 * WHY THIS IS ITS OWN MODULE. The rule used to live privately inside the registry
 * install gate (`packManifestV2Gate.ts`), so it guarded exactly one lane: the
 * registry installer. The vendored/operator chain loader registered 63 chains
 * with 624 unpinned references and nothing noticed, because "a gate on one lane
 * is not a gate on the concept". Both lanes now call this module, and so does
 * expansion, which is the third place a chain reference is read.
 *
 * WHAT COUNTS AS "A REFERENCE TO A NODE TYPE". Three sites, not one:
 *   - `dag.nodes[].typeId`;
 *   - `dag.nodes[].compensation.nodeTypeId` — the manifest schema says it "MUST
 *     resolve at expansion exactly as `typeId` does", so it is a node-type
 *     reference and is pinned the same way. The gate this replaced skipped it;
 *   - `subChains[].ref.version` for an EXTERNAL sub-chain (a range here is
 *     schema-legal, so only a host rule can refuse it). A SIBLING sub-chain is a
 *     string naming a chain in the same pack and carries no version by design.
 */

/** Exact SemVer, including the optional prerelease/build suffixes. */
export const EXACT_SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface ParsedNodeRef {
  /** The bare node type id — the key every registry in this host resolves by. */
  typeId: string;
  /** The exact pinned version, or `null` when the reference carries none or a range. */
  version: string | null;
  /** The reference carried an `@…` suffix that is NOT an exact version (a range). */
  ranged: boolean;
}

/** A NODE pin is plain `major.minor.patch` — exactly the `@[0-9]+\.[0-9]+\.[0-9]+`
 *  suffix `ids.schema.json#/$defs/typeId` admits. Deliberately narrower than
 *  `EXACT_SEMVER_RE` (which the external sub-chain `version` keeps): a prerelease
 *  node pin would pass this rule and then fail the schema, so the rule matches the
 *  schema rather than the looser SemVer grammar. */
export const NODE_PIN_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** Split `core.ai.callPrompt@1.0.0` into its bare id and pin. A node type id never
 *  contains `@` (ids.schema.json), so the LAST `@` is the separator. */
export function parseNodeRef(ref: string): ParsedNodeRef {
  const at = ref.lastIndexOf('@');
  if (at <= 0) return { typeId: ref, version: null, ranged: false };
  const typeId = ref.slice(0, at);
  const suffix = ref.slice(at + 1);
  return NODE_PIN_RE.test(suffix)
    ? { typeId, version: suffix, ranged: false }
    : { typeId, version: null, ranged: true };
}

export type ChainPinProblem = 'unpinned' | 'ranged' | 'conflict';

export interface ChainPinFinding {
  chainId: string;
  /** Which reference site, e.g. `dag.nodes[n1].typeId`. */
  site: string;
  ref: string;
  problem: ChainPinProblem;
}

/** The minimal chain shape this rule reads — structural, so both the loader's
 *  typed `WorkflowChain` and the gate's raw manifest object fit. */
interface PinnableChain {
  chainId?: unknown;
  dag?: unknown;
  subChains?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Every node-type reference in one chain, in document order, with its site. */
function nodeRefs(chain: PinnableChain): Array<{ site: string; ref: string }> {
  const out: Array<{ site: string; ref: string }> = [];
  const nodes = asRecord(chain.dag)?.['nodes'];
  if (!Array.isArray(nodes)) return out;
  for (const raw of nodes) {
    const node = asRecord(raw);
    if (!node) continue;
    const id = typeof node['id'] === 'string' ? node['id'] : '?';
    if (typeof node['typeId'] === 'string') out.push({ site: `dag.nodes[${id}].typeId`, ref: node['typeId'] });
    const compensation = asRecord(node['compensation']);
    if (compensation && typeof compensation['nodeTypeId'] === 'string') {
      out.push({ site: `dag.nodes[${id}].compensation.nodeTypeId`, ref: compensation['nodeTypeId'] });
    }
  }
  return out;
}

/**
 * Every exact-pin violation in `chain`. `conflict` = the same node type pinned to
 * two DIFFERENT versions inside one chain: this host resolves one version per
 * type, so such a chain cannot be honoured as written and is refused rather than
 * silently collapsed to one of them.
 */
export function chainPinFindings(chain: PinnableChain): ChainPinFinding[] {
  const chainId = typeof chain.chainId === 'string' ? chain.chainId : '?';
  const findings: ChainPinFinding[] = [];
  const seen = new Map<string, string>();
  for (const { site, ref } of nodeRefs(chain)) {
    const parsed = parseNodeRef(ref);
    if (parsed.ranged) { findings.push({ chainId, site, ref, problem: 'ranged' }); continue; }
    if (parsed.version === null) { findings.push({ chainId, site, ref, problem: 'unpinned' }); continue; }
    const prior = seen.get(parsed.typeId);
    if (prior !== undefined && prior !== parsed.version) {
      findings.push({ chainId, site, ref, problem: 'conflict' });
      continue;
    }
    seen.set(parsed.typeId, parsed.version);
  }
  const subChains = chain.subChains;
  if (Array.isArray(subChains)) {
    subChains.forEach((raw, i) => {
      const ref = asRecord(asRecord(raw)?.['ref']);
      if (!ref) return; // a sibling string ref: same pack, no version by design
      const version = ref['version'];
      // grade-code C-11: an ABSENT version is unpinned, not a range named "undefined".
      if (typeof version !== 'string' || version.length === 0) {
        findings.push({ chainId, site: `subChains[${i}].ref.version`, ref: '(none)', problem: 'unpinned' });
      } else if (!EXACT_SEMVER_RE.test(version)) {
        findings.push({ chainId, site: `subChains[${i}].ref.version`, ref: version, problem: 'ranged' });
      }
    });
  }
  return findings;
}

/** The refusal message for one finding — the wording the registry gate has
 *  always used, so an operator reading either lane sees the same sentence. */
/**
 * grade-code C-4 — one actionable line for a pack's findings: the first finding in
 * full, WHERE it is (chain + site), and how many more there are, so an operator
 * fixes the whole pack in one pass instead of one reference per reboot.
 */
export function describePinFindings(findings: readonly ChainPinFinding[]): string {
  const first = findings[0];
  if (!first) return '';
  const more = findings.length - 1;
  return `${describePinFinding(first)} [chain ${first.chainId}, ${first.site}]${more > 0 ? ` (+${more} more; run \`npm run chains:pin\`)` : ''}`;
}

export function describePinFinding(f: ChainPinFinding): string {
  if (f.site.startsWith('subChains[')) {
    return `workflow-chain external sub-chain version "${f.ref}" MUST be an exact SemVer pin; ranges are forbidden (spec/v2/core/workflow-chain-packs.md §"Exact pins")`;
  }
  if (f.problem === 'conflict') {
    return `workflow-chain "${f.chainId}" pins node type "${parseNodeRef(f.ref).typeId}" to two different versions (${f.site}); a chain may pin each typeId once`;
  }
  return `workflow-chain node typeId "${f.ref}" MUST end in an exact SemVer pin (for example @1.0.0); ranges and unpinned references are forbidden (spec/v2/core/workflow-chain-packs.md §"Exact pins")`;
}

/**
 * The chain with every node-type reference reduced to its BARE id, plus the pins
 * it declared. ADR 0766 D1: everything downstream of registration (expansion, the
 * requirements pre-flight, the listing, the executor registry) keys on the bare
 * id, so the pin is lifted into a side record once, here, instead of being parsed
 * at a dozen consumers. Idempotent: an already-bare chain comes back unchanged
 * with no pins, which is what lets expansion call it defensively.
 */
export function normalizeChainPins<C extends PinnableChain>(chain: C): { chain: C; nodePins: Record<string, string> } {
  const nodePins: Record<string, string> = {};
  const dag = asRecord(chain.dag);
  const nodes = dag?.['nodes'];
  if (!dag || !Array.isArray(nodes)) return { chain, nodePins };
  let changed = false;
  const bare = (ref: string): string => {
    const parsed = parseNodeRef(ref);
    if (parsed.version !== null && nodePins[parsed.typeId] === undefined) nodePins[parsed.typeId] = parsed.version;
    if (parsed.typeId !== ref) changed = true;
    return parsed.version !== null ? parsed.typeId : ref;
  };
  const nextNodes = nodes.map((raw) => {
    const node = asRecord(raw);
    if (!node) return raw;
    const next: Record<string, unknown> = { ...node };
    if (typeof node['typeId'] === 'string') next['typeId'] = bare(node['typeId']);
    const compensation = asRecord(node['compensation']);
    if (compensation && typeof compensation['nodeTypeId'] === 'string') {
      next['compensation'] = { ...compensation, nodeTypeId: bare(compensation['nodeTypeId']) };
    }
    return next;
  });
  if (!changed) return { chain, nodePins };
  return { chain: { ...chain, dag: { ...dag, nodes: nextNodes } }, nodePins };
}

/** A pin this host cannot honour: the type IS installed, at another version. */
export interface PinMismatch {
  typeId: string;
  pinned: string;
  installed: string;
}

/**
 * Pins this host cannot honour: a pinned node type that IS installed, but at a
 * different version (ADR 0766 D3). A pinned type that is not installed at all is
 * left to the caller's existing missing-type check, so it is never reported
 * twice.
 *
 * Structured, because the two gaps need different remedies and different words:
 * grade-ux U-1 found the first cut folded these into `missingNodeTypeIds` as
 * `typeId@pinned` strings, so the pre-flight told a user a node that IS
 * installed was "not installed", with no way to name either version.
 */
export function pinMismatches(
  nodePins: Readonly<Record<string, string>> | undefined,
  installedVersionOf: (typeId: string) => string | undefined,
): PinMismatch[] {
  if (!nodePins) return [];
  const out: PinMismatch[] = [];
  for (const [typeId, pinned] of Object.entries(nodePins)) {
    const installed = installedVersionOf(typeId);
    if (installed !== undefined && installed !== pinned) out.push({ typeId, pinned, installed });
  }
  return out.sort((a, b) => a.typeId.localeCompare(b.typeId));
}

/** `pinMismatches` as `typeId@pinned` strings — the log/warning spelling. */
export function unmetNodePins(
  nodePins: Readonly<Record<string, string>> | undefined,
  installedVersionOf: (typeId: string) => string | undefined,
): string[] {
  return pinMismatches(nodePins, installedVersionOf).map((m) => `${m.typeId}@${m.pinned}`);
}
