/**
 * RFC 0142 leg B — the emission witness, tested host-side.
 *
 * The published leg drives `POST /v1/host/sample/artifacttypes/runproduce` and
 * asserts the run emitted `artifact.created`. This asserts the same contract
 * in-repo so a regression is caught here rather than in someone else's suite,
 * and so the seam is not the only thing witnessing itself.
 *
 * WHY THE SEAM STARTS A REAL RUN. RFC 0142 §Alternatives rejected asserting
 * emission through the existing `produce` route, correctly: that route calls
 * `persistRunArtifact`, which by explicit design emits nothing
 * (`runArtifactStore.ts:18`). A leg there would witness the wrong path forever
 * and report green. On this host emission is a property of REAL RUNS —
 * `feature.documents.nodes.generate-from-template` is the only
 * `ctx.emit('artifact.created', ...)` site in the tree.
 *
 * NON-VACUITY IS THE POINT. A soft-skip is an early return, which vitest counts
 * as PASSED — the exact failure the artifact-type seam was built to end. So leg 1
 * asserts the run reached `completed` AND the event is present AND its payload is
 * right; a 404 from the seam fails the test rather than skipping it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TOKEN = 'dev-token';
let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // ADR 0561 — this seam registers types and reads runs across tenants.
  process.env.OPENWOP_API_KEY = `${TOKEN}:*`;
  // Gates BOTH the seam and the deterministic `mock` provider the emitting node
  // drafts through. Without it the seam 404s, which is the correct production
  // posture and the wrong test posture.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const eventsOf = async (runId: string) => {
  const res = await fetch(`${BASE}/v1/runs/${runId}/events/poll?fromSeq=0&limit=300`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const json = (await res.json()) as { events?: Array<{ type: string; payload?: Record<string, unknown> }> };
  return json.events ?? [];
};

describe('RFC 0142 leg B — runproduce starts a real run that emits artifact.created', () => {
  it('leg 1: a registered document type is produced by a REAL run, and the event carries it', async () => {
    const { status, body } = await post('/v1/host/sample/artifacttypes/runproduce', { artifactTypeId: 'doc.one-pager' });
    expect(status, `seam did not answer: ${JSON.stringify(body)}`).toBe(200);
    const runId = body['runId'] as string;
    expect(runId, 'the seam MUST return the runId it started').toBeTruthy();
    expect(body['runStatus'], 'a non-terminal status means the witness proved nothing').toBe('completed');

    const events = await eventsOf(runId);
    const created = events.filter((e) => e.type === 'artifact.created');
    expect(
      created.length,
      `no artifact.created among: ${events.map((e) => e.type).join(', ')}`,
    ).toBe(1);

    // The payload is the substance — an event with the wrong type would satisfy
    // "an event was emitted" and witness nothing (RFC 0142 §Conformance requires
    // the leg to discriminate payload correctness, not mere presence).
    const p = created[0]?.payload ?? {};
    expect(p['artifactTypeId'], 'the event must carry the requested type').toBe('doc.one-pager');
    expect(p['registered'], 'a registered type MUST be marked registered').toBe(true);
    expect(p['valid'], 'the payload must have passed schema validation before emit').toBe(true);
  });

  it('leg 2: an UNREGISTERED type is refused rather than silently producing nothing', async () => {
    const { status, body } = await post('/v1/host/sample/artifacttypes/runproduce', { artifactTypeId: 'vendor.nope.not-registered' });
    expect(status, 'an unregistered id is a caller error, not a host failure to emit').toBe(400);
    expect(String(body['message'] ?? '')).toContain('not registered');
  });

  it('leg 3: a missing artifactTypeId is refused', async () => {
    const { status } = await post('/v1/host/sample/artifacttypes/runproduce', {});
    expect(status).toBe(400);
  });
});
