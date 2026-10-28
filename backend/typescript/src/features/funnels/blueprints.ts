/**
 * ADR 0948 P3a — funnel blueprints: the chains a Funnel Architect may run.
 *
 * ONE predicate decides "a blueprint", for discovery, generation and boot
 * registration alike, so "listed" and "runnable" can never disagree:
 *   - the chain lives in the funnels chain pack (pinned by NAME: a superadmin can
 *     install chain packs at runtime, and a prefix alone could be claimed by any);
 *   - its id starts `funnels.blueprint.` (so `funnels.optimize-step` and the
 *     `funnels.step.*` sub-chains are never offered);
 *   - it is registered as a chain-backed workflow (deterministic id, gated by the
 *     funnels toggle through the ADR 0823 launch funnel).
 * The blueprint chains themselves ship in ADR 0948 P2b. Until then the set is empty
 * and the tools say so; nothing is faked.
 */
import { listChains, getChain, type WorkflowChain } from '../../host/workflowChainPackLoader.js';
import { getChainBackedWorkflow, registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { isCompilableInputSchema } from '../../host/runInputValidation.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('funnels.blueprints');

export const FUNNELS_CHAIN_PACK = 'core.openwop.workflows.funnels';
export const BLUEPRINT_PREFIX = 'funnels.blueprint.';
export const FUNNEL_ARCHITECT_AGENT_ID = 'vendor.openwop-app.funnels.agents.funnel-architect';
/** Params the generate lane fills itself; a caller never supplies them. */
export const FILLED_BY_GENERATE = ['orgId', 'briefId', 'campaignId'] as const;

const packs = new Set<string>([FUNNELS_CHAIN_PACK]);
/** Test seam: admit a fixture chain pack as a blueprint source. */
export function __admitBlueprintPackForTest(packName: string): void { packs.add(packName); }

export interface Blueprint {
  chainId: string;
  label: string;
  description: string;
  version: string;
  /** The chain's own JSON-Schema `parameters`, verbatim (the SSoT). */
  parameters: WorkflowChain['parameters'];
}

/** A blueprint must declare the params generate fills, and its schema must compile:
 *  generate validates the model's params against it, and a schema it cannot enforce
 *  (or one that refuses `orgId`/`briefId`/`campaignId` under additionalProperties:false)
 *  would make every call fail in a way the model cannot repair. So such a chain is
 *  simply not a blueprint (logged), rather than listed and broken. */
function hasGenerateContract(chain: WorkflowChain): boolean {
  const props = (chain.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  return FILLED_BY_GENERATE.every((k) => Object.prototype.hasOwnProperty.call(props, k)) && isCompilableInputSchema(chain.parameters);
}

const isBlueprintEntry = (e: { packName: string; chain: WorkflowChain }): boolean =>
  packs.has(e.packName) && e.chain.chainId.startsWith(BLUEPRINT_PREFIX) && hasGenerateContract(e.chain);

/** Register every blueprint chain as chain-backed, owned by the funnels toggle, AND
 *  each sub-chain it declares (recursively): a chain-backed parent binds a
 *  `subChainRef` to the SAME-ID child, so an unregistered child would dangle at run
 *  time. Children are registered, never listed (the prefix keeps them out).
 *  Idempotent; called at feature boot (and by tests after loading a fixture).
 *  Not re-run on a runtime chain-pack reload: a reinstalled pack's blueprints take
 *  effect at the next boot (the one predicate keeps both tools consistent with that). */
export function registerFunnelBlueprints(): void {
  const done = new Set<string>();
  const register = (chainId: string): void => {
    if (done.has(chainId)) return;
    done.add(chainId);
    const entry = getChain(chainId);
    if (!entry) return;
    for (const sub of entry.chain.subChains ?? []) register(typeof sub.ref === 'string' ? sub.ref : sub.ref.chainId);
    registerChainBackedWorkflow(chainId, { featureId: 'funnels' });
  };
  for (const e of listChains()) {
    if (!packs.has(e.packName) || !e.chain.chainId.startsWith(BLUEPRINT_PREFIX)) continue;
    if (!hasGenerateContract(e.chain)) {
      log.warn('funnel_blueprint_contract_missing', { chainId: e.chain.chainId, needs: FILLED_BY_GENERATE });
      continue;
    }
    register(e.chain.chainId);
  }
}

/** The blueprints that can actually run, right now. */
export function runnableBlueprints(): Blueprint[] {
  return listChains()
    .filter((e) => isBlueprintEntry(e) && getChainBackedWorkflow(e.chain.chainId) !== undefined)
    .map((e) => ({
      chainId: e.chain.chainId,
      label: e.chain.label,
      description: e.chain.description,
      version: e.chain.version,
      parameters: e.chain.parameters,
    }))
    .sort((a, b) => a.chainId.localeCompare(b.chainId));
}

/** One blueprint by id, under the same predicate; null when not runnable. */
export function getRunnableBlueprint(chainId: string): Blueprint | null {
  const e = getChain(chainId);
  if (!e || !isBlueprintEntry(e) || getChainBackedWorkflow(chainId) === undefined) return null;
  return { chainId, label: e.chain.label, description: e.chain.description, version: e.chain.version, parameters: e.chain.parameters };
}
