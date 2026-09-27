/**
 * RFC 0139 legs 3 and 5, driven through the HTTP SEAM.
 *
 * openwop-1 blocked the RFC on two findings my loader-level mirror could not
 * catch, and both live at the seam rather than in the loader:
 *
 *  - LEG 5: the loader picks fields BY NAME and never validates the manifest, so
 *    a typo'd `dispalyName` was silently ignored, the type registered, and the
 *    seam returned 200 where the leg asserts non-2xx. "A host can satisfy legs
 *    1-4 by simply ignoring its manifest schema entirely."
 *  - FINDING 2 / LEG 3: `registered` was computed by querying the PROCESS-GLOBAL
 *    registry. Legs 3/4 install the same id twice; `registerArtifactType`
 *    overwrites on success and deletes nothing on failure, so a rejected second
 *    install left install #1's entry behind — 200, with a projection read off the
 *    STALE entry and therefore identical to baseline. A green differential while
 *    the extension changed behaviour.
 *
 * Asserting the same properties at the loader is not the same as running them
 * through the path the suite drives. That distinction is the whole finding.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

const ID = 'vendor.conformance.note';
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', additionalProperties: false,
  required: ['title'], properties: { title: { type: 'string' } },
};

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const manifest = (entry: Record<string, unknown>) => ({
  name: 'vendor.conformance.notes', version: '1.0.0', kind: 'artifact-type',
  engines: { openwop: '>=1.1' },
  artifactTypes: [{ artifactTypeId: ID, schemaRef: 'schemas/note.schema.json', schemaVersion: 1, ...entry }],
});

/** `withSchema:false` omits the schema BODY, so the manifest stays canonically
 *  valid but the loader cannot resolve its `schemaRef` — the only way to reach the
 *  finding-2 path, since leg 5's validator would otherwise reject first. */
const install = async (m: unknown, withSchema = true) => {
  const res = await fetch(`${BASE}/v1/host/sample/artifacttypes/install`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: m, schemas: withSchema ? { [ID]: SCHEMA } : {} }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe('RFC 0139 — seam legs', () => {
  it('leg 5: a manifest with an UNKNOWN key is REJECTED, not silently ignored', async () => {
    // `dispalyName` is the typo openwop-1 named. Before the fix the loader picked
    // fields by name, ignored it, registered the type, and returned 200.
    const bad = await install(manifest({ dispalyName: 'typo' }));
    expect(bad.status, 'an unknown manifest key was silently accepted').not.toBe(200);
    expect(String(bad.json.error ?? '')).toBe('manifest_invalid');
  });

  it('leg 5 is not over-broad: a RECOGNISED-shape manifest still installs', async () => {
    // The guard must reject typos without rejecting valid packs, or leg 1 reds.
    const ok = await install(manifest({ displayName: 'Note', exportFormats: ['json'] }));
    expect(ok.status).toBe(200);
    expect(ok.json.registeredIds).toEqual([ID]);
  });

  it('finding 2: a REJECTED second install does not report the stale prior entry', async () => {
    // Install once so the global registry holds an entry for ID.
    const first = await install(manifest({ displayName: 'Note', exportFormats: ['json'] }));
    expect(first.status).toBe(200);

    // Now install the SAME id with a CANONICALLY VALID manifest the LOADER
    // rejects (its schemaRef cannot resolve). This is the only route to the
    // finding-2 path: a manifest rejected by leg 5's validator never reaches the
    // `registered` computation, so testing with a typo would pass for the wrong
    // reason. Sabotage proved that — reverting the finding-2 fix left a
    // typo-based test GREEN.
    const second = await install(manifest({ displayName: 'Note' }), false);
    expect(second.status, 'the stale prior registration masked a rejected install').not.toBe(200);
    // H27-b — `registeredIds` moved from a forbidden top-level key to
    // `details.registeredIds`. Read it there and ASSERT IT IS PRESENT first:
    // the old `?? []` would have kept this leg green against a body that stopped
    // reporting the field at all — which is the very finding it exists to catch.
    // `undefined ?? []` is not an observation.
    const details = (second.json.details ?? {}) as { registeredIds?: unknown };
    expect(details.registeredIds, 'the refusal must still report what it registered').toBeDefined();
    expect(details.registeredIds).toEqual([]);
  });

  it('the projection reflects THIS install, not whatever the registry happens to hold', async () => {
    const ok = await install(manifest({ displayName: 'Note', exportFormats: ['json'] }));
    const proj = (ok.json.projection ?? []) as Array<Record<string, unknown>>;
    expect(proj).toHaveLength(1);
    expect(proj[0]!.artifactTypeId).toBe(ID);
    expect(proj[0]!.displayName).toBe('Note');
    expect(proj[0]!.schemaKeys).toEqual(['title']);
  });
});
