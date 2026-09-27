/**
 * W1.1 reference vehicle (ADR 0289 / RFC 0128 G4) — the `prepare-onward` node + the
 * `openwop-app.cdp.sync-to-openwop-host` built-in workflow that drive the openwop-host
 * onward egress. The node wraps `ctx.features['destination-sync'].prepareOnward`,
 * flattens `envelopes[0]` onto `onwardBody` for the downstream `core.openwop.http.fetch`,
 * and stays honest-off when purpose propagation is disabled. The workflow registers the
 * `prepare-onward → http.fetch (POST)` spine (egress rides the http node, ADR 0262 #3).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { prepareOnward } from '../../../packs/feature.destination-sync.nodes/index.mjs';
import { buildDestinationSyncSurface } from '../src/features/destination-sync/surface.js';
import { createDestinationSync } from '../src/features/destination-sync/destinationSyncService.js';
import { getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import { ONWARD_SYNC_WORKFLOW_ID } from '../src/features/destination-sync/onwardSyncWorkflow.js';

type NodeResult = {
  status: string;
  outputs?: Record<string, unknown>;
  error?: { code: string; message: string };
};

const nodeCtx = (inputs: Record<string, unknown>, surface: unknown) => ({
  inputs,
  features: { 'destination-sync': surface },
});

describe('CDP W1.1 prepare-onward node contract', () => {
  it('wraps prepareOnward and flattens envelopes[0] onto onwardBody + peerIngestUrl', async () => {
    const envelope = { source: 'webhook', permittedPurposes: ['analytics', 'marketing'], webhook: { body: { email_address: 'a@x.com' } } };
    const surface = {
      prepareOnward: async ({ syncId, records }: { syncId: string; records: unknown[] }) => ({
        envelopes: [envelope],
        peerIngestUrl: 'https://peer.example/v1/host/openwop-app/trigger-bridge/ingest',
        count: records.length,
        dropped: 0,
        connectionId: 'conn:peer',
        forwarded: syncId,
      }),
    };
    const out: NodeResult = await prepareOnward(nodeCtx({ syncId: 'dsync:1', records: [{ email: 'a@x.com' }] }, surface));
    expect(out.status).toBe('success');
    expect(out.outputs!.count).toBe(1);
    expect(out.outputs!.envelopes).toEqual([envelope]);
    expect(out.outputs!.onwardBody).toEqual(envelope); // the FIRST envelope, for the http.fetch body
    expect(out.outputs!.peerIngestUrl).toBe('https://peer.example/v1/host/openwop-app/trigger-bridge/ingest');
    expect(out.outputs!.connectionId).toBe('conn:peer');
  });

  it('onwardBody is null when there are no eligible envelopes (all dropped)', async () => {
    const surface = { prepareOnward: async () => ({ envelopes: [], peerIngestUrl: 'https://peer.example/ingest', count: 0, dropped: 2 }) };
    const out: NodeResult = await prepareOnward(nodeCtx({ syncId: 'dsync:1', records: [] }, surface));
    expect(out.status).toBe('success');
    expect(out.outputs!.onwardBody).toBeNull();
    expect(out.outputs!.dropped).toBe(2);
  });

  it('propagates the surface flag-off error (honest-off) as a failed outcome', async () => {
    const surface = { prepareOnward: async () => ({ error: 'purpose_propagation_disabled', envelopes: [], count: 0 }) };
    const out: NodeResult = await prepareOnward(nodeCtx({ syncId: 'dsync:1', records: [] }, surface));
    expect(out.status).toBe('failed');
    expect(out.error!.code).toBe('purpose_propagation_disabled');
  });

  it('fails closed without a syncId', async () => {
    const surface = { prepareOnward: async () => ({ envelopes: [], count: 0 }) };
    const out: NodeResult = await prepareOnward(nodeCtx({ records: [] }, surface));
    expect(out.status).toBe('failed');
    expect(out.error!.code).toBe('validation_error');
  });

  it('throws when the host capability is missing (no prepareOnward)', async () => {
    await expect(prepareOnward(nodeCtx({ syncId: 'x' }, {}))).rejects.toMatchObject({ code: 'host_capability_missing' });
  });
});

describe('CDP W1.1 prepare-onward over the REAL surface (flag gate)', () => {
  const TENANT = 'tenant-owp-w11';
  beforeAll(async () => {
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  });
  afterAll(() => { delete process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED; });

  async function makeSync(): Promise<string> {
    const sync = await createDestinationSync({
      tenantId: TENANT, name: 'Peer CDP', destinationKind: 'openwop-host', sourceObject: 'contact',
      fieldMap: [{ from: 'email', to: 'email_address' }],
      connectionId: 'conn:peer', peerIngestUrl: 'https://peer.example/v1/host/openwop-app/trigger-bridge/ingest',
    });
    return sync.syncId;
  }

  it('flag OFF → the real surface error propagates through the node', async () => {
    delete process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED;
    const syncId = await makeSync();
    const surface = buildDestinationSyncSurface({ tenantId: TENANT });
    const out: NodeResult = await prepareOnward(nodeCtx({ syncId, records: [{ email: 'a@x.com', permittedPurposes: ['marketing'] }] }, surface));
    expect(out.status).toBe('failed');
    expect(out.error!.code).toBe('purpose_propagation_disabled');
  });

  it('flag ON → real onward envelopes flow through, onwardBody = the first labelled envelope', async () => {
    process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED = 'true';
    const syncId = await makeSync();
    const surface = buildDestinationSyncSurface({ tenantId: TENANT });
    const out: NodeResult = await prepareOnward(nodeCtx({
      syncId,
      records: [
        { email: 'keep@x.com', permittedPurposes: ['marketing', 'analytics'] },
        { email: 'drop@x.com', permittedPurposes: [] }, // [] fail-closed → dropped
      ],
    }, surface));
    expect(out.status).toBe('success');
    expect(out.outputs!.dropped).toBe(1);
    expect(out.outputs!.peerIngestUrl).toBe('https://peer.example/v1/host/openwop-app/trigger-bridge/ingest');
    // onwardBody = the first labelled envelope — the exact JSON the http.fetch node POSTs.
    expect(out.outputs!.onwardBody).toMatchObject({
      permittedPurposes: ['analytics', 'marketing'], // re-emitted label on the body we POST
      webhook: { body: { email_address: 'keep@x.com' } },
    });
  });
});

describe('CDP W1.1 built-in workflow registration', () => {
  beforeAll(async () => {
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  });

  it('registers openwop-app.cdp.sync-to-openwop-host with the prepare-onward → http.fetch spine', () => {
    // ADR 0472 P4: migrated out of the builtin quarantine to a same-id chain pack;
    // resolves through the chain-backed registry. Chain expansion prefixes node/edge
    // ids (`<slug>_<exp>_<origId>`), so match by suffix.
    const wf = getChainBackedWorkflow(ONWARD_SYNC_WORKFLOW_ID);
    expect(wf).toBeDefined();
    expect(wf!.workflowId).toBe('openwop-app.cdp.sync-to-openwop-host');
    const bare = (id: string): string => id.replace(/^.*_/, '');

    const prep = wf!.nodes.find((n) => bare(n.nodeId) === 'prepare-onward');
    const egress = wf!.nodes.find((n) => bare(n.nodeId) === 'egress');
    expect(prep!.typeId).toBe('feature.destination-sync.nodes.prepare-onward');
    expect(egress!.typeId).toBe('core.openwop.http.fetch');

    // Egress is the sanctioned http node (ADR 0262 #3): POST, url resolved at RUN time
    // from the dispatch-seeded `peerIngestUrl` via the config template (not a declared
    // param — the executor's config resolver honors `{{inputs.*}}` against the run bag).
    expect(egress!.config).toMatchObject({ method: 'POST', url: '{{inputs.peerIngestUrl}}' });

    // body ← prepare-onward.onwardBody over the graph edge (cross-node data-flow).
    const edge = wf!.edges!.find((e) => bare(e.sourceNodeId) === 'prepare-onward' && bare(e.targetNodeId) === 'egress');
    expect(edge).toMatchObject({ sourceOutput: 'onwardBody', targetInput: 'body' });

    // The authoring params that feed node inputs (peerIngestUrl rides config at runtime).
    const varNames = (wf!.variables ?? []).map((v) => v.name).sort();
    expect(varNames).toEqual(['records', 'syncId']);
  });
});
