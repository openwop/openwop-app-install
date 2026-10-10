/**
 * ADR 0765 — this host's claims for the v2 EXTENSION families
 * (`spec/v2/core/capabilities.md` §3.2: `extensions["<org>.<extensionName>"]`;
 * RFC 0220 §B, witnessed by the suite's `v2-ext-family-claims`, ≥ 2.42.7).
 *
 * THE RULE: a family is claimed only when this backend EXECUTES it. For the
 * discovery-only families that means: the executor wires the node-context
 * surface the family's vendored pack calls (`executor.ts` builds it with
 * `buildHostSurfaceBundle`, the same function used here), and that surface has
 * every method the pack calls. Each record is a FUNCTION (the
 * `registerV2Extension` contract): it re-checks that wiring and THROWS when a
 * method is gone, which omits the record — so a claim cannot outlive the thing
 * it names. `test/adr0765-ext-family-records.test.ts` pins `methods` to the
 * pack source, so the declared contract cannot drift from the pack either.
 *
 * `messaging` (ADR 0769) is wired differently: `ctx.messaging` is not a bundle
 * member but the executor's own adapter (`makeMessagingAdapter` — SMS + relay
 * chat egress), so its claim probes that factory (`wiring: 'adapter'`).
 *
 * `data-integration` (ADR 0783 D9) is an adapter too: `makeDataIntegrationAdapter`
 * serves six of the pack's eight methods. The two it does not (`fetchA2A`,
 * `applyBinding`) are named in `unavailable`, with the `ctx.dataIntegration.*`
 * method each needs, so the contract test still accounts for every call.
 *
 * Deliberately NOT claimed (ADR 0765 § Withheld, ADR 0769): `brand`,
 * `entities`, `coordination`, `a2ui-surface`. This host vendors the first
 * three families' packs, but the executor wires no `ctx.brand` /
 * `ctx.entities` / `ctx.agentRuntime`, so their nodes fail
 * `host_capability_missing`; claiming them would advertise a pack that cannot run.
 */
import { buildHostSurfaceBundle } from './inMemorySurfaces.js';
import { registerV2Extension } from './discoveryExtensions.js';
import { SUPPORTED_RUN_ENCODINGS } from './restTransport.js';
import { makeMessagingAdapter } from './chatEgressAdapter.js';
import { makeDataIntegrationAdapter } from './dataIntegrationAdapter.js';
import type { Storage } from '../storage/storage.js';

/** The org every record here is advertised under (registered in the corpus declaration). */
const ORG = 'openwop-app';

export interface ExtFamilyClaim {
  /** `spec/v2/declaration.json` `extensionName` (kebab-case; the record key's name half). */
  readonly extensionName: string;
  /** The `ctx.<surface>` the executor wires: a `HostSurfaceBundle` member, or (`wiring: 'adapter'`) an executor adapter. */
  readonly surface: 'canvas' | 'chat' | 'kanban' | 'knowledge' | 'webResearch' | 'launchStudio' | 'messaging' | 'dataIntegration';
  /** How the executor builds `ctx.<surface>` — default `'bundle'` (`buildHostSurfaceBundle`). */
  readonly wiring?: 'bundle' | 'adapter';
  /** The vendored node pack whose nodes call that surface. */
  readonly nodePack: string;
  /** Every `ctx.<surface>.<method>` the pack calls — pinned to the pack source by the test. */
  readonly methods: readonly string[];
  /** Pack operations that need a context this host does not wire (they fail closed). */
  readonly unavailable?: readonly { readonly node: string; readonly needs: string }[];
  /** The surface answers from seeded demo data rather than tenant-authored state. */
  readonly demoData?: boolean;
  /** The ADR that decided this claim, when not ADR 0765 itself. */
  readonly adr?: string;
}

export const EXT_FAMILY_CLAIMS: readonly ExtFamilyClaim[] = [
  { extensionName: 'canvas', surface: 'canvas', nodePack: 'vendor.myndhyve.canvas', methods: ['create', 'invoke', 'read', 'write'] },
  { extensionName: 'chat', surface: 'chat', nodePack: 'vendor.myndhyve.chat', methods: ['emitCard', 'sendMessage', 'updateCard'] },
  {
    extensionName: 'kanban', surface: 'kanban', nodePack: 'vendor.myndhyve.kanban',
    methods: ['automateRules', 'boardCreate', 'boardReview', 'resourceMonitor', 'taskAssign', 'taskCreateBatch', 'taskGet', 'timelinePlan'],
    unavailable: [{ node: 'task.decompose', needs: 'ctx.aiEnvelope' }],
  },
  { extensionName: 'knowledge', surface: 'knowledge', nodePack: 'vendor.myndhyve.knowledge-tools', methods: ['retrieve'] },
  {
    extensionName: 'launch-studio', surface: 'launchStudio', nodePack: 'vendor.myndhyve.launch-studio',
    methods: ['buildProjectContext', 'getStudio', 'resolveLinkedArtifacts'], demoData: true,
  },
  {
    extensionName: 'web-research', surface: 'webResearch', nodePack: 'vendor.myndhyve.web-research',
    methods: ['fetchBatch', 'research', 'search'],
    unavailable: [{ node: 'research synthesis (ctx.aiEnvelope.generate)', needs: 'ctx.aiEnvelope' }],
  },
  {
    extensionName: 'messaging', surface: 'messaging', wiring: 'adapter', nodePack: 'vendor.myndhyve.entities', adr: '0769',
    methods: ['dispatchEgressEnvelope'],
    unavailable: [
      { node: 'core.entities.projectCreate', needs: 'ctx.entities' },
      { node: 'core.workflow.assetDecisionGate', needs: 'ctx.entities' },
    ],
  },
  {
    extensionName: 'data-integration', surface: 'dataIntegration', wiring: 'adapter', nodePack: 'vendor.myndhyve.data-integration', adr: '0783',
    // ADR 0865 served the last two (`applyBinding` P1, `fetchA2A` P2), so
    // every node in the pack is claimed and nothing is listed unavailable.
    methods: ['applyBinding', 'computeVariable', 'fetchA2A', 'fetchGraphql', 'fetchMCP', 'fetchRest', 'fetchVariable', 'transform'],
  },
];

type Bundle = ReturnType<typeof buildHostSurfaceBundle>;
let probe: Bundle | undefined;
/** The executor's own surface bundle, built once for a probe scope (the factories are fixed at boot). */
function probeBundle(): Bundle {
  probe ??= buildHostSurfaceBundle({ tenantId: 'default', runId: 'ext-family-probe' });
  return probe;
}

/** The executor adapters wired onto `ctx` outside the bundle, built for a probe scope. */
const ADAPTERS: Record<string, () => object> = {
  // Construction reads no deps (every call does), so the probe needs no storage.
  messaging: () => makeMessagingAdapter({ storage: {} as Storage, tenantId: 'default', runId: 'ext-family-probe' }),
  dataIntegration: () => makeDataIntegrationAdapter({ runId: 'ext-family-probe' }),
};

/** The methods of a claim the executor's surface does NOT provide (empty = claimable). */
export function missingMethods(claim: ExtFamilyClaim, bundle: Bundle = probeBundle()): string[] {
  const surface = (claim.wiring === 'adapter'
    ? ADAPTERS[claim.surface]?.()
    : (bundle as unknown as Record<string, unknown>)[claim.surface]) as Record<string, unknown> | undefined;
  if (!surface || typeof surface !== 'object') return [...claim.methods];
  return claim.methods.filter((m) => typeof surface[m] !== 'function');
}

/** The record for one family, or a throw (→ omitted by `v2Extensions()`) when its wiring is gone. */
export function extFamilyRecord(claim: ExtFamilyClaim, bundle: Bundle = probeBundle()): Record<string, unknown> {
  const missing = missingMethods(claim, bundle);
  if (missing.length > 0) {
    throw new Error(`ext family ${claim.extensionName}: ctx.${claim.surface} lacks ${missing.join(', ')}`);
  }
  return {
    servedBy: { nodeContext: `ctx.${claim.surface}`, nodePack: claim.nodePack, adr: claim.adr ?? '0765' },
    operations: [...claim.methods],
    ...(claim.unavailable ? { unavailable: claim.unavailable.map((u) => ({ ...u })) } : {}),
    ...(claim.demoData ? { demoData: true } : {}),
  };
}

/**
 * `rest-transport` (spec/v2/ext/restTransport): conditional GET and response
 * compression on run reads. Both facets come from the SAME code that serves
 * them (`host/restTransport.ts`), so the advert cannot name an encoding the
 * host cannot apply.
 */
export function restTransportRecord(): Record<string, unknown> {
  return {
    conditionalRunGet: true,
    contentEncodings: [...SUPPORTED_RUN_ENCODINGS],
    servedBy: { module: 'host/restTransport.ts', adr: '0765' },
  };
}

export function registerExtFamilyRecords(): void {
  for (const claim of EXT_FAMILY_CLAIMS) {
    registerV2Extension(`${ORG}.${claim.extensionName}`, () => extFamilyRecord(claim));
  }
  registerV2Extension(`${ORG}.rest-transport`, restTransportRecord);
}
