/**
 * ADR 0962 D4.1 (as corrected) — is this a campaign run? An external agent (the
 * MCP lane) can never satisfy a gate on one.
 *
 * A run is a campaign run when ANY of:
 *   - it carries the ADR 0941 run tag (`campaignOrchestration`);
 *   - it carries the ADR 0921 client stamp (`openwop-app.campaignOps`);
 *   - its pinned definition was expanded from a campaign chain (`metadata.chainId`
 *     starts with `campaign-`; every chain in a `core.openwop.workflows.campaign-*`
 *     pack does, and no other does — `adr0962-p0-campaign-gates.test.ts`), which
 *     survives a tenant's from-chain copy;
 * or any ANCESTOR run (`parentRunId`, bounded) is one. Past the bound, or at a
 * missing ancestor, the answer is `true`: an unprovable chain fails closed.
 *
 * The keys are plain constants: the host must not import a feature. A parity test
 * pins them to the feature exports, so a renamed key fails a test instead of
 * silently reopening the lane.
 */
import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { resolveRunDefinition } from './resolveRunDefinition.js';
import { APPROVAL_WAIT_KEY_PREFIX } from './autonomyPolicy/waiters.js';
import { APPROVAL_GATE_TYPE_IDS } from './approvalGateTypeIds.js';
import type { InterruptRecord } from '../types.js';

type Catalog = Parameters<typeof resolveRunDefinition>[1];

export const CAMPAIGN_RUN_TAG_METADATA_KEY = 'campaignOrchestration';
export const CAMPAIGN_CLIENT_STAMP_METADATA_KEY = 'openwop-app.campaignOps';
export const CAMPAIGN_CHAIN_ID_PREFIX = 'campaign-';
const MAX_ANCESTORS = 8;

function stampedCampaign(run: RunRecord): boolean {
  const md = (run.metadata ?? {}) as Record<string, unknown>;
  // Malformed reserved provenance is not proof that a run is outside the boundary.
  const present = (v: unknown): boolean => v !== undefined;
  return present(md[CAMPAIGN_RUN_TAG_METADATA_KEY]) || present(md[CAMPAIGN_CLIENT_STAMP_METADATA_KEY]);
}

async function fromCampaignChain(run: RunRecord, catalog: Catalog): Promise<boolean> {
  const resolved = await resolveRunDefinition(run, catalog).catch(() => null);
  if (!resolved) return true; // an unavailable definition cannot prove a non-campaign run
  const chainId = (resolved.definition.metadata as { chainId?: unknown } | undefined)?.chainId;
  return typeof chainId === 'string' && chainId.startsWith(CAMPAIGN_CHAIN_ID_PREFIX);
}

export async function isCampaignRun(storage: Pick<Storage, 'getRun'>, hostSuite: { workflowCatalog: Catalog }, runId: string): Promise<boolean> {
  let id: string | undefined = runId;
  for (let depth = 0; id; depth += 1) {
    if (depth > MAX_ANCESTORS) return true;
    const run = await storage.getRun(id);
    // The interrupt's own run missing: resolveAndResume refuses anyway. A missing
    // ANCESTOR is an unprovable chain: fail closed.
    if (!run) return true;
    if (stampedCampaign(run) || (await fromCampaignChain(run, hostSuite.workflowCatalog))) return true;
    id = run.parentRunId;
  }
  return false;
}

/**
 * Is this interrupt a GATE (an approval to give), whatever `kind` the node
 * suspended with? `kind: 'approval'`, or the node's type is a registered approval
 * gate type (`core.chat.approvalGate` and friends suspend with their own reason).
 */
export async function isApprovalGate(storage: Pick<Storage, 'getRun'>, hostSuite: { workflowCatalog: Catalog }, interrupt: Pick<InterruptRecord, 'kind' | 'runId' | 'nodeId'> & Partial<Pick<InterruptRecord, 'data'>>): Promise<boolean> {
  if (interrupt.kind === 'approval') return true;
  const key = (interrupt.data as { key?: unknown } | null)?.key;
  if (interrupt.kind === 'external-event' && typeof key === 'string' && key.startsWith(APPROVAL_WAIT_KEY_PREFIX)) return true;
  const run = await storage.getRun(interrupt.runId);
  if (!run) return true;
  const resolved = await resolveRunDefinition(run, hostSuite.workflowCatalog).catch(() => null);
  const typeId = resolved?.definition.nodes.find((n) => n.nodeId === interrupt.nodeId)?.typeId;
  return typeof typeId !== 'string' || APPROVAL_GATE_TYPE_IDS.has(typeId.replace(/@.*$/, ''));
}
