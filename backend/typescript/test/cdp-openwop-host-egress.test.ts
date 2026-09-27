/**
 * ADR 0289 / RFC 0128 §3 — the `openwop-host` destination egress. Covers the pure envelope
 * builder (re-emit ⊆ received / never-widen, unlabelled = no constraint, `[]` fail-closed
 * dropped, field-map, dedup, CDC) and the `prepareOnward` surface verb (flag-gate + the
 * OpenWOP envelopes a workflow egresses via `core.openwop.http.fetch`, ADR 0262 ruling #3 —
 * no bespoke egress). This is the non-vacuous tier-1 witness substrate for RFC 0128 G4.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildOnwardEnvelopes, createDestinationSync, type DestinationSync } from '../src/features/destination-sync/destinationSyncService.js';
import { buildDestinationSyncSurface } from '../src/features/destination-sync/surface.js';

/** Narrow the open surface-verb result's `envelopes` field (an `unknown`) for assertions. */
type OnwardEnvelope = { permittedPurposes?: string[]; webhook: { body: Record<string, unknown> } };

type SyncCore = Pick<DestinationSync, 'syncMode' | 'cursor' | 'cursorField' | 'fieldMap' | 'narrowTo' | 'destinationKind'>;
const baseSync: SyncCore = {
  destinationKind: 'openwop-host',
  syncMode: 'batch',
  cursorField: 'updatedAt',
  fieldMap: [{ from: 'email', to: 'email_address' }, { from: 'name', to: 'full_name' }],
};

describe('buildOnwardEnvelopes — the algebra on the OpenWOP-envelope hop', () => {
  it('re-emits the received label verbatim when no narrowTo, and field-maps the body', () => {
    const { envelopes, dropped } = buildOnwardEnvelopes(baseSync, [
      { email: 'a@x.com', name: 'A', permittedPurposes: ['marketing', 'analytics'] },
    ]);
    expect(dropped).toBe(0);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.source).toBe('webhook');
    expect(envelopes[0]!.permittedPurposes).toEqual(['analytics', 'marketing']); // normalized (sorted)
    expect(envelopes[0]!.webhook.body).toEqual({ email_address: 'a@x.com', full_name: 'A' });
  });

  it('narrowTo intersects (narrows) the received grant', () => {
    const { envelopes } = buildOnwardEnvelopes(
      { ...baseSync, narrowTo: ['analytics'] },
      [{ email: 'a@x.com', permittedPurposes: ['marketing', 'analytics'] }],
    );
    expect(envelopes[0]!.permittedPurposes).toEqual(['analytics']);
  });

  it('never widens: a narrowTo broader than the received label stays ⊆ received', () => {
    const { envelopes } = buildOnwardEnvelopes(
      { ...baseSync, narrowTo: ['analytics', 'marketing', 'advertising'] },
      [{ email: 'a@x.com', permittedPurposes: ['analytics'] }],
    );
    expect(envelopes[0]!.permittedPurposes).toEqual(['analytics']); // NOT widened to marketing/advertising
  });

  it('an unlabelled record carries no permittedPurposes (asserts no constraint)', () => {
    const { envelopes } = buildOnwardEnvelopes(baseSync, [{ email: 'a@x.com' }]);
    expect(envelopes).toHaveLength(1);
    expect('permittedPurposes' in envelopes[0]!).toBe(false);
  });

  it('`[]` is fail-closed: dropped before egress, never an envelope', () => {
    const { envelopes, dropped } = buildOnwardEnvelopes(baseSync, [
      { email: 'keep@x.com', permittedPurposes: ['marketing'] },
      { email: 'drop@x.com', permittedPurposes: [] },
    ]);
    expect(dropped).toBe(1);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.webhook.body.email_address).toBe('keep@x.com');
  });

  it('seeds a stable dedupKey from dedupField', () => {
    const { envelopes } = buildOnwardEnvelopes(baseSync, [{ email: 'a@x.com', id: 'contact-7' }], { dedupField: 'id' });
    expect(envelopes[0]!.dedupKey).toBe('contact-7');
  });

  it('CDC mode ships only records past the watermark + advances the cursor', () => {
    const cdc: SyncCore = { ...baseSync, syncMode: 'cdc', cursor: '2026-07-01' };
    const { envelopes, nextCursor } = buildOnwardEnvelopes(cdc, [
      { email: 'old@x.com', updatedAt: '2026-06-01', permittedPurposes: ['marketing'] },
      { email: 'new@x.com', updatedAt: '2026-07-05', permittedPurposes: ['marketing'] },
    ]);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.webhook.body.email_address).toBe('new@x.com');
    expect(nextCursor).toBe('2026-07-05');
  });
});

describe('prepareOnward surface verb — flag-gated envelope prep for the http-node egress', () => {
  const TENANT = 'tenant-owp-egress';
  beforeAll(async () => {
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    // Boot the app once to initialize host-ext persistence (DurableCollection storage).
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

  it('is honest-off when the flag is unset: no envelopes, no leak', async () => {
    delete process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED;
    const syncId = await makeSync();
    const surface = buildDestinationSyncSurface({ tenantId: TENANT });
    const out = await surface.prepareOnward!({ syncId, records: [{ email: 'a@x.com', permittedPurposes: ['marketing'] }] });
    expect(out.error).toBe('purpose_propagation_disabled');
    expect(out.envelopes).toEqual([]);
  });

  it('with the flag on, returns labelled envelopes + the peer URL for the http-node send', async () => {
    process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED = 'true';
    const syncId = await makeSync();
    const surface = buildDestinationSyncSurface({ tenantId: TENANT });
    const out = await surface.prepareOnward!({
      syncId,
      records: [
        { email: 'keep@x.com', permittedPurposes: ['marketing', 'analytics'] },
        { email: 'drop@x.com', permittedPurposes: [] },
      ],
    });
    expect(out.error).toBeUndefined();
    expect(out.peerIngestUrl).toBe('https://peer.example/v1/host/openwop-app/trigger-bridge/ingest');
    expect(out.connectionId).toBe('conn:peer');
    expect(out.dropped).toBe(1); // the [] record
    const envs = out.envelopes as OnwardEnvelope[];
    expect(envs).toHaveLength(1);
    expect(envs[0]!.permittedPurposes).toEqual(['analytics', 'marketing']); // re-emitted label on the envelope
  });

  it('rejects a non-openwop-host sync', async () => {
    process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED = 'true';
    const sync = await createDestinationSync({
      tenantId: TENANT, name: 'ESP', destinationKind: 'esp', sourceObject: 'contact', fieldMap: [{ from: 'email', to: 'e' }],
    });
    const surface = buildDestinationSyncSurface({ tenantId: TENANT });
    const out = await surface.prepareOnward!({ syncId: sync.syncId, records: [] });
    expect(out.error).toBe('not_openwop_host');
  });
});
