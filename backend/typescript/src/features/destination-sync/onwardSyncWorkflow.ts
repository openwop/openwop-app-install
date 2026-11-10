/**
 * W1.1 reference workflow — "sync CDP records to a peer OpenWOP host" (ADR 0289 /
 * RFC 0128 G4). The operator vehicle that drives the `openwop-host` egress: it
 * produces the onward OpenWOP envelopes (each carrying the re-emitted
 * `permittedPurposes` label — ⊆ received, never-widen, `[]`-drop) and egresses the
 * first through the sanctioned `core.openwop.http.fetch` node (ADR 0262 ruling #3).
 *
 *   prepare-onward → egress (core.openwop.http.fetch, POST)
 *
 * The chain pack is the definition (`examples/workflow-chain-packs/destination-sync`,
 * registered same-id by `registerLegacyDefsChainBacked`, ADR 0472 P4). This module
 * keeps only the stable id and the output-role map the fragment cannot carry. ADR 1024
 * (`CDP2WF-22`) cut the nodes, edges and variables that used to sit here: they
 * duplicated the pack, and the header said the workflow was still registered through
 * `BackendFeature.builtinWorkflows` long after that seam was deleted.
 *
 * DATA-FLOW WIRING:
 *  - `body` ← `prepare-onward.onwardBody` over the graph edge.
 *  - `url`  ← the run variable `peerIngestUrl` through the http node's
 *    `config.url` template (`{{inputs.peerIngestUrl}}`); config cannot read an
 *    upstream output port. ADR 1024 D2.5 declares `peerIngestUrl` as a chain
 *    parameter bound into `prepare-onward`, which refuses `destination_mismatch`
 *    unless it is the sync's stored URL, so the run cannot aim the egress anywhere
 *    the sync's owner did not configure.
 *
 * To fire a leg: `POST /v1/runs` for this workflowId with
 *   inputs = { syncId, records, peerIngestUrl }.
 *
 * @see docs/adr/0289-openwop-host-destination-egress-cross-host-purpose-carry.md
 * @see docs/adr/1024-cdp-consent-egress-and-erasure-reach.md
 */

import type { ChainBackedRoleMap } from '../../host/chainBackedWorkflows.js';

/** The registered same-id workflow — the W1.1 CDP → peer-OpenWOP-host vehicle. */
export const ONWARD_SYNC_WORKFLOW_ID = 'openwop-app.cdp.sync-to-openwop-host';

export const onwardSyncWorkflow: ChainBackedRoleMap = {
  workflowId: ONWARD_SYNC_WORKFLOW_ID,
  nodes: [{ nodeId: 'egress', outputRole: 'primary' }],
};

/** The chain-backed SSoT sources this feature contributes (ADR 0472 P4). */
export const ONWARD_SYNC_WORKFLOWS: ReadonlyArray<ChainBackedRoleMap> = [onwardSyncWorkflow];
