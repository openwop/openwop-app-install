/**
 * RFC 0013 — the host-expansion conformance witness seam.
 *
 * `@openwop/openwop-conformance`'s `workflow-chain-host-expansion.test.ts` (gated on
 * `workflowChainPacks.hostExpansionSeam`, decoupled from the semantic `supported`
 * claim by the #828 erratum) POSTs `/v1/host/sample/workflow-chain:expand` to witness
 * that a live host wraps the RFC 0013 `expandChain()` algorithm correctly. Since
 * openwop-conformance ≥1.52.0 the scenario LOADS the published
 * `vendor.openwop.workflow-chain-sample` fixture pack and derives the expected output
 * from the reference expander using THIS host's returned `expansionId` — so the check
 * is against the spec algorithm for the identical published pack, zero hardcoding.
 *
 * This handler resolves that fixture pack (vendored in the conformance package) and
 * runs THIS host's `expandChain()` (the same expander the workflow editor / from-chain
 * route use). Seam-gated on OPENWOP_TEST_SEAM_ENABLED (404s in prod), mirroring
 * `dispatchFanOut.ts` / `chainDeferredExpandSeam.ts`; the fixture pack stays OUT of the
 * product chain catalog (loaded here only, not via the boot-time loader roots).
 *
 * @see docs/adr/0250-deferred-parameter-mode.md §6
 */

import type { Express, Request, Response } from 'express';
import { expandChain, isChainExpansionSeamServable, loadChainSamplePack } from '../host/workflowChainPackLoader.js';
import { sendError } from '../middleware/errorEnvelope.js';

const SEAM_PATH = '/v1/host/sample/workflow-chain:expand';

/** The resolver lives in host/workflowChainPackLoader.ts: the ADVERTISEMENT
 *  consults it too, and this module already imports that one. ONE function, so
 *  advertising and serving cannot disagree about whether the seam is servable. */
const loadSamplePack = loadChainSamplePack;

function handle(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { packName?: string; chainId?: string; parameters?: Record<string, unknown> };

  // Missing chainId ⇒ malformed request (before pack resolution).
  if (typeof body.chainId !== 'string' || body.chainId.length === 0) {
    sendError(res, 422, 'invalid_request', 'chainId is required');
    return;
  }
  const pack = loadSamplePack();
  if (!pack || body.packName !== pack.name) {
    sendError(res, 404, 'pack_not_found', `unknown pack: ${String(body.packName)}`);
    return;
  }
  const chain = pack.chains.find((c) => c.chainId === body.chainId);
  if (!chain) {
    sendError(res, 404, 'chain_not_found', `unknown chain: ${body.chainId}`);
    return;
  }

  try {
    // Expansion-time mode (default) — the same `expandChain` the editor/from-chain use.
    const def = expandChain(chain, { params: body.parameters ?? {} });
    const meta = (def.metadata ?? {}) as { expansionId?: string };
    // Map the host's internal `WorkflowDefinition` (executor shape) onto the RFC 0013
    // wire shape the scenario checks against the reference expander: node `id` (not
    // `nodeId`), edge `from`/`to` refs (`<node>[.<port>]`, not sourceNodeId/output),
    // and the chain's capabilities propagated onto each expanded node (RFC 0013
    // §Expansion step 8 — this host records them at `metadata.capabilities`).
    const chainCaps = chain.capabilities;
    const nodes = (def.nodes as unknown as Array<Record<string, unknown>>).map((n) => ({
      id: n.nodeId as string,
      typeId: n.typeId as string,
      ...(n.config ? { config: n.config } : {}),
      ...(chainCaps ? { capabilities: chainCaps } : {}),
      // RFC 0157 — this mapping is a node-rebuilding ALLOWLIST like every other
      // one in this repo, so a chain-declared inverse action would be dropped
      // exactly here and the witness would report an expansion that silently
      // lost it. Conditional: a pack declaring neither (every published fixture
      // today) serializes byte-identically, so the pinned conformance
      // comparison is unchanged.
      ...(n.compensation ? { compensation: n.compensation } : {}),
      ...(n.irreversibleEffect !== undefined ? { irreversibleEffect: n.irreversibleEffect } : {}),
    }));
    const edges = (def.edges as unknown as Array<Record<string, unknown>>).map((e) => {
      const from = e.sourceOutput ? `${String(e.sourceNodeId)}.${String(e.sourceOutput)}` : String(e.sourceNodeId);
      const to = e.targetInput ? `${String(e.targetNodeId)}.${String(e.targetInput)}` : String(e.targetNodeId);
      return { from, to };
    });
    res.status(200).json({
      expansionId: meta.expansionId,
      chainId: chain.chainId,
      packName: pack.name,
      packVersion: pack.version,
      nodes,
      edges,
    });
  } catch (err) {
    // A malformed pack / unresolvable typeId surfaces as a 422 (invalid_request);
    // expansion of a well-formed published fixture is not expected to throw.
    sendError(res, 422, 'invalid_request', err instanceof Error ? err.message : String(err));
  }
}

export function registerWorkflowChainExpandSeamRoutes(app: Express): void {
  // Conformance witness seam — env-gated (404s in prod), registered BEFORE
  // testSeam.ts's catch-all sample→openwop-app rewrite.
  // The same FUNCTION as the advertisement, not a second copy of its expression —
  // serving and advertising move together, or "advertises when the seam is
  // served" becomes a contradiction.
  if (isChainExpansionSeamServable()) {
    app.post(SEAM_PATH, handle);
  }
}
