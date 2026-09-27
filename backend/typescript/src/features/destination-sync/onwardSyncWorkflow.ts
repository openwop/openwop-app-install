/**
 * W1.1 reference workflow — "sync CDP records to a peer OpenWOP host" (ADR 0289 /
 * RFC 0128 G4). The missing OPERATOR VEHICLE that drives the `openwop-host` egress
 * mechanism: it produces the onward OpenWOP envelopes (each carrying the re-emitted
 * `permittedPurposes` label — ⊆ received, never-widen, `[]`-drop) and egresses the
 * first through the sanctioned `core.openwop.http.fetch` node (ADR 0262 ruling #3 —
 * egress rides the http node, NOT a bespoke sender in the feature node).
 *
 * Registered via `BackendFeature.builtinWorkflows` (restart-safe, cross-instance —
 * the ADR 0072 precedent), exactly like `campaign-studio.campaign-orchestration`.
 *
 *   prepare-onward → egress (core.openwop.http.fetch, POST)
 *
 * DATA-FLOW WIRING (how the http.fetch node's `url` + `body` resolve — the executor's
 * cross-node vocabulary is deliberately narrow, so this is the honest composition):
 *
 *  - `body`  ← the `prepare-onward` node's `onwardBody` output (the FIRST envelope),
 *    carried over the graph EDGE `sourceOutput:'onwardBody' → targetInput:'body'`.
 *    The DAG scheduler maps a source node's named output onto the target's input
 *    port, so `core.openwop.http.fetch` reads it as `ctx.inputs.body`.
 *
 *  - `url`   ← the run variable `peerIngestUrl`, resolved into the http node's
 *    `config.url` template (`{{inputs.peerIngestUrl}}`) by the executor's config
 *    interpolation (`interpolateRunInputs`, whole-value string substitution — NOT
 *    URL-encoded, unlike the http node's own `{{var}}` template substitution which
 *    would break a full URL). `config.url` is a CONFIG field, and config reads the
 *    per-run variable bag — it cannot read an upstream node's output port — so the
 *    peer ingest URL is supplied as a run input, not carried over an edge. The
 *    `prepare-onward` node ALSO emits `peerIngestUrl` (echoed from the sync config)
 *    for verification/parity, but the transport URL binds from the variable.
 *
 * To fire a leg: `POST /v1/runs` for this workflowId with
 *   inputs = { syncId, records, peerIngestUrl }
 * where `syncId` names an `openwop-host` destination sync (destinationKind =
 * 'openwop-host', peerIngestUrl set) and `peerIngestUrl` is that same peer ingest
 * URL (the http node's POST target). `records` is the CDP record batch.
 *
 * No new RFC / no new ADR — composes Accepted wire only (RFC 0128 label + the
 * trigger-bridge ingest contract), per ADR 0289 § RFC gate.
 *
 * @see docs/adr/0289-openwop-host-destination-egress-cross-host-purpose-carry.md
 * @see ../openwop/RFCS/0128 (permittedPurposes propagation, G4)
 */

import type { WorkflowDefinition } from '../../executor/types.js';

const PREPARE_ONWARD = 'feature.destination-sync.nodes.prepare-onward';
const HTTP_FETCH = 'core.openwop.http.fetch';

/** The registered built-in workflow id — the W1.1 CDP → peer-OpenWOP-host vehicle. */
export const ONWARD_SYNC_WORKFLOW_ID = 'openwop-app.cdp.sync-to-openwop-host';

export const onwardSyncWorkflow: WorkflowDefinition = {
  workflowId: ONWARD_SYNC_WORKFLOW_ID,
  nodes: [
    {
      nodeId: 'prepare-onward',
      typeId: PREPARE_ONWARD,
      inputs: {
        syncId: { type: 'variable', variableName: 'syncId' },
        records: { type: 'variable', variableName: 'records' },
      },
    },
    {
      nodeId: 'egress',
      typeId: HTTP_FETCH,
      // `url` binds from the run variable `peerIngestUrl` (config reads the variable
      // bag, not an upstream port); `body` binds from the edge below.
      config: { method: 'POST', url: '{{inputs.peerIngestUrl}}' },
      outputRole: 'primary',
    },
  ],
  edges: [
    // The FIRST onward envelope → the http node's request body.
    { edgeId: 'e1', sourceNodeId: 'prepare-onward', sourceOutput: 'onwardBody', targetNodeId: 'egress', targetInput: 'body' },
  ],
  variables: [
    { name: 'syncId', type: 'string', description: "The 'openwop-host' destination sync to forward (destinationKind='openwop-host', peerIngestUrl set).", required: true },
    { name: 'records', type: 'array', description: 'The CDP record batch to CDC-filter, purpose-label, and forward.', required: false, defaultValue: [] },
    { name: 'peerIngestUrl', type: 'string', description: "The peer host's trigger-bridge ingest URL — the POST target for the onward envelope (bound into the http node's config.url).", required: true },
  ],
  metadata: {
    kind: 'cdp-onward-sync',
    feature: 'destination-sync',
    adr: 'ADR-0289',
    rfc: 'RFC-0128',
    gap: 'G4',
  },
};

/** Feature-contributed built-in workflows for `BackendFeature.builtinWorkflows`. */
export const ONWARD_SYNC_WORKFLOWS: ReadonlyArray<WorkflowDefinition> = [onwardSyncWorkflow];
