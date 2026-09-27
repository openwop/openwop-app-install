/**
 * ADR 0099 — core IoC seam: transform tool-output content at the typed
 * tool-result boundary (the host tool executor's `{content}` / the provider
 * `tool_result` construction — the point a string is *known* to be tool output).
 *
 * Core holds an identity function pointer; a feature registers a transform at
 * boot (the `registerFeatureSurface` / `setNodePackResolver` inversion pattern).
 * Core never imports the feature. Applied at `agentDispatch` (manifest dispatch)
 * and `bootstrap/nodes` (the chat/workflow LLM-tools node onToolUse return).
 *
 * The transform MUST be pure + total — it is on the model round-trip hot path
 * and MUST NOT throw. Callers also wrap it defensively (fail-open to identity),
 * so the worst case is "no savings," never a broken run.
 */

import type { CompactionDecision } from '../executor/types.js';
import { builtinAgentTool } from './agentToolProvider.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.toolResultTransform');

export interface ToolResultTransformContext {
  /** The per-run decision frozen at run-start (absent ⇒ identity). */
  decision?: CompactionDecision;
  /** The tool whose output this is — for future per-tool exemptions/telemetry. */
  toolName?: string;
  /** The run's tenant, when available (absent on the runless dispatch path). */
  tenantId?: string;
}

/**
 * ADR 0099 Phase 4 — observability. Savings are reported as side-channel
 * telemetry (NOT a recorded run event, NOT durable state, NOT the wire), so it
 * is replay-safe: re-running the boundary on replay just re-emits a metric.
 * `emitRawCostAttrs` is NOT used — its allowlist drops non-`openwop.cost.*`
 * keys. The observer is swappable so a host can route savings elsewhere and so
 * tests can assert it; the default logs at INFO — this IS the savings signal the
 * feature exists to surface, at the same granularity as the per-call cost
 * emitter, so it must be visible in a standard `info`-level deployment (a `debug`
 * default left it invisible in prod, defeating the observability goal).
 */
export interface CompactionSaving {
  toolName?: string;
  tenantId?: string;
  charsBefore: number;
  charsAfter: number;
  charsSaved: number;
}
export type CompactionObserver = (saving: CompactionSaving) => void;

const defaultObserver: CompactionObserver = (s) => log.info('tool_output_compacted', { ...s });
let observer: CompactionObserver = defaultObserver;

/** Swap the telemetry sink (host integration / tests). */
export function setCompactionObserver(fn: CompactionObserver): void {
  observer = fn;
}
export function __resetCompactionObserver(): void {
  observer = defaultObserver;
}

export type ToolResultTransform = (content: string, ctx: ToolResultTransformContext) => string;

const IDENTITY: ToolResultTransform = (content) => content;

let current: ToolResultTransform = IDENTITY;

/** Feature registration seam — called once at boot. */
export function registerToolResultTransform(fn: ToolResultTransform): void {
  current = fn;
}

/** Test/reset hook. */
export function __resetToolResultTransform(): void {
  current = IDENTITY;
}

/** XCH-INFRA-1 (LLM-EXCHANGE-AUDIT Wave 5) — tools whose output IS a
 *  schema/catalog are ALWAYS exempt.
 *
 *  SCOPE NARROWED 2026-08-23 (ADR 0604). This used to say "in both modes",
 *  because `lossless` dropped empty fields (`required: []` is a statement, not
 *  noise). That is fixed at the TRANSFORM: `lossless` is now minify-only and
 *  provably information-preserving, so it cannot harm a schema tool — or any of
 *  the other ~200 tools nobody thought to enumerate here. This list therefore
 *  guards only the `lossy` path (array elision + disclosed field-dropping),
 *  which is per-agent opt-in and off by default.
 *
 *  That distinction is the whole reason the list was a floor. "Schema-carrying"
 *  is not a fact about a TOOL; the harm was a fact about the TRANSFORM, and a
 *  transform hurts every tool that returns a present-but-empty field. Fixing the
 *  transform fixes all of them at once. What remains here is a genuine per-tool
 *  property — "an elided enum lies to the model" — and it is now DERIVED from a
 *  declaration on the tool (`BuiltinTool.schemaCarrying`) rather than
 *  remembered in this array; see `isSchemaReadExempt` below.
 *  A HOST-LEVEL invariant, deliberately not part of the frozen per-run
 *  decision: it is deterministic given `toolName`, so replay is unaffected,
 *  and a schema tool added later is protected on old runs too. */
export const SCHEMA_READ_EXEMPT_TOOLS: readonly string[] = [
  'openwop:schema.lookup',
  'openwop:slides.catalog',
  'openwop:app-builder.catalog',
  'openwop:app-builder.get-design',
  'openwop:documents.list-templates',
  'openwop:entities.describe-type', // ADR 0386 — runtime type schemas must reach the model byte-exact
  // PMX-15 (ADR 0590) — list-lists returns the criteria SCHEMA (the exact ids
  // score-idea requires) and list-ranked-ideas re-emits it with the semantic
  // note; a compacted criteria array feeds the model wrong scoring ids.
  // Parity-asserted against the exported tool-id constants in
  // test/priority-matrix-agent-tools.test.ts.
  'openwop:priority-matrix.list-lists',
  'openwop:priority-matrix.list-ranked-ideas',
  // WFAC-3 (ADR 0596) — the Workflow Architect's closed-world catalog. Its exact
  // sibling `openwop:app-builder.catalog` has been exempt since this list
  // existed; this one was missed. It returns every legal node typeId WITH its
  // config/input/output JSON Schemas, and the closed world is the whole contract:
  // an elided `enum`, a dropped `required: []`, or a truncated node array makes
  // the model author against a catalog that is not this host's, and the authored
  // graph is then refused by `findUnknownTypeIds` — a defect the model cannot
  // diagnose, because the thing it was shown was wrong. Latent only because the
  // compaction toggle defaults off. Parity-asserted against the exported tool-id
  // constant in `features/workflow-author/__tests__/promptCatalogParity.test.ts`.
  'openwop:feature.workflow-author.nodes.draft',
  // ADR 0604 (TOCC-2) — the five misses the feature-32 assessment named, plus
  // the ones the DERIVED census found once `BUILTINS` was resolved through both
  // of its spreads. Each also declares `schemaCarrying: true` at its
  // registration site; this array is the belt to that braces (see below).
  'openwop:feature.agent-author.nodes.get',
  'openwop:feature.workflow-author.nodes.get',
  'openwop:documents.get-template',
  'openwop:slides.get-design',
  'openwop:feature.crm.nodes.segment-vocabulary',
  'openwop:feature.crm.nodes.validate-segment',
  'openwop:cad.get-design',
  'openwop:drawings.get-design',
  'openwop:campaign-studio.get-design',
  // ADR 0604 review H4 — the completeness gate forces a ROW, not a CORRECT row,
  // and three of the rows it forced were wrong. Each of these five was
  // classified `false` in one table with no recorded adjudication, and the
  // negative control then PINNED that answer. The per-tool rationale lives at
  // each registration site; the adjudication of every remaining `TOCC-2a` lead
  // — including the ones that stayed `false` — is the table in
  // `test/schema-read-exemption-completeness.test.ts`.
  'openwop:bi.list-metrics',
  'openwop:campaign-channels.channels',
  'openwop:intent-ledger.get',
  'openwop:cms.get-draft-page',
  'openwop:interactive-artifacts.get',
];

/**
 * ADR 0604 (TOCC-2) — the exemption predicate. TWO sources, deliberately:
 *
 *  - the tool's OWN declaration (`BuiltinTool.schemaCarrying`), which is the
 *    real source of truth and needs no edit here when a tool is added; and
 *  - the literal array above, consulted unconditionally.
 *
 * The array is not redundant. `builtinAgentTool` answers from a map that is
 * populated by `registerFeatureAgentTool` at feature init, so in any process
 * where a feature has not registered — a unit test, a partially-booted host —
 * the declaration lane returns `undefined`, and a lookup miss would fail OPEN
 * straight into "compact it". A literal that is always present cannot miss.
 * `test/schema-read-exemption-completeness.test.ts` asserts the two agree, so
 * they cannot silently diverge.
 *
 * WHY THIS IS NOT JUST A LONGER LIST. The list can only ever be a floor: the
 * population is not statically enumerable (6 static entries + 2 spreads +
 * runtime mutation), so no census of it is complete by construction. The
 * declaration is complete by construction for every tool that carries it, and
 * the completeness test supplies the runtime denominator that forces a new tool
 * to be classified. Emptying the array no longer makes the gate green, and no
 * longer makes the RUNTIME wrong either.
 */
export function isSchemaReadExempt(toolName: string | undefined): boolean {
  if (!toolName) return false;
  if (SCHEMA_READ_EXEMPT_TOOLS.includes(toolName)) return true;
  // ADR 0720 D2 — the two cases this line used to collapse, stated apart.
  //
  // `builtinAgentTool(x)?.schemaCarrying === true` answers `false` BOTH for "this tool
  // is registered and does not carry a schema" AND for "this host cannot classify this
  // tool at all". That is the same conflation ADR 0719 fixed one iteration earlier in
  // `useFeatureVisible`, where an ABSENT toggle read as an OFF toggle and silently
  // removed two console tabs — same shape, different subsystem.
  //
  // WHO IS UNCLASSIFIABLE TODAY: only MCP. Feature/pack tools are NOT — despite what
  // `CEC-1` filed — because `registerFeatureAgentTool` writes into the SAME `BUILTINS`
  // map this reads (`agentToolProvider.ts:596`), so their `schemaCarrying: true` is
  // honoured (`features/intent-ledger/agentTools.ts:43` is a live example).
  //
  // THE OUTCOME IS UNCHANGED AND DELIBERATE: an unclassifiable tool is still compacted.
  // The exemption exists because "an elided enum lies to the model" about the CLOSED
  // vocabulary it must author against; an external MCP payload — always
  // `<UNTRUSTED>`-fenced — is not that vocabulary. What changes is that this is now a
  // decision at the site rather than a silent fallthrough, so a future schema-carrying
  // registrar OUTSIDE `BUILTINS` is a visible gap instead of an inherited silence.
  const known = builtinAgentTool(toolName);
  if (!known) return false; // unclassifiable (MCP) — compacted, by the reasoning above
  return known.schemaCarrying === true;
}

/**
 * Apply the registered transform. Fail-open: any throw (or a missing/`off`
 * decision) returns the original content unchanged.
 */
export function applyToolResultTransform(content: string, ctx: ToolResultTransformContext): string {
  if (!ctx.decision || ctx.decision.mode === 'off') return content;
  // XCH-INFRA-1 / ADR 0604 — schema/catalog reads stay byte-exact regardless of
  // decision, DERIVED from the tool's own declaration (with the literal array as
  // a registration-independent floor). See `isSchemaReadExempt`.
  if (isSchemaReadExempt(ctx.toolName)) return content;
  // Per-tool exemption (ADR 0099 §residuals): a tool whose output must stay
  // byte-exact is skipped. The exempt list is frozen in the decision (replay-safe).
  if (ctx.toolName && ctx.decision.exemptTools?.includes(ctx.toolName)) return content;
  let out: string;
  try {
    out = current(content, ctx);
  } catch {
    return content;
  }
  // Phase 4 — report savings as side-channel telemetry; never let it throw.
  if (out.length < content.length) {
    try {
      observer({
        ...(ctx.toolName ? { toolName: ctx.toolName } : {}),
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
        charsBefore: content.length,
        charsAfter: out.length,
        charsSaved: content.length - out.length,
      });
    } catch {
      /* telemetry must never break a run */
    }
  }
  return out;
}
