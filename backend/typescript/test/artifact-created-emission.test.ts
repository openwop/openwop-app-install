/**
 * G8 discriminator — does a REAL run emit `artifact.created`?
 *
 * The claim history matters here. A grep over the backend src .ts population
 * found ZERO emit sites and I reported "advertised but emitted nowhere" at ~85%.
 * That was a POPULATION error: node behaviour ships in PACKS, and
 * `packs/feature.documents.nodes/index.mjs:125` emits
 * `ctx.emit('artifact.created', artifact)` when the assembled template binds an
 * `artifactTypeId`. The executor's `ctx.emit` (executor.ts:481) appends verbatim
 * to the run-event log. openwop-1 refused to record the negative from a grep and
 * asked for a run — this is that run, and it discriminates BOTH directions:
 *
 *  - bound template   → the event MUST appear, typed and marked registered
 *  - unbound template → the event MUST NOT appear (emission is conditional,
 *    so its absence on the unbound path proves the bound path's presence is
 *    caused by the binding, not ambient)
 *
 * No prior test anywhere asserts this event from a live run — the docblocks in
 * cad/campaign-studio/drawings tests mention it in prose only.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../src/executor/types.js';

// Static imports hoist above beforeAll, and the provider registry reads
// OPENWOP_COMPAT_PROVIDER_ENABLED at module load — so src modules are imported
// DYNAMICALLY after the env is set, or 'compat' is never in aiProviders.supported.
let registerWorkflow: (def: WorkflowDefinition) => void;

const TOKEN = 'dev-token';
const TENANT = 'tenant-dev';
const ORG = 'org-g8';

let BASE = '';
let server: http.Server;
let templateBoundId = '';
let templateUnboundId = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // ADR 0561 — scope the key to the tenant this suite actually operates under.
  process.env.OPENWOP_API_KEY = `${TOKEN}:${TENANT}`;

  // The generate node drafts via the run-scoped provider. `mock` is the
  // deterministic conformance provider (SUPPORTED_PROVIDERS includes it), chat
  // path gated on OPENWOP_TEST_SEAM_ENABLED — no network, no key.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';

  const { createApp } = await import('../src/index.js');
  const { createTemplate } = await import('../src/features/documents/documentsService.js');
  ({ registerWorkflow } = await import('../src/host/workflowsRegistry.js'));
  // The mock provider returns '' unless PROGRAMMED per nodeId — an unprogrammed
  // run fails `generation_empty`, which is how the first attempt died.
  const { programMock } = await import('../src/providers/dispatchMock.js');
  programMock('gen', [{ content: 'Generated one-pager body.' }, { content: 'Generated one-pager body.' }]);
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });

  // Templates created in-process: template CRUD is not what this probe tests,
  // and `doc.one-pager` is a host-native registered artifact type.
  const bound = await createTemplate({
    tenantId: TENANT, orgId: ORG, name: 'G8 bound', kind: 'doc', outputFormat: 'markdown',
    promptBody: 'Write a one-pager about {{topic}}.', artifactTypeId: 'doc.one-pager', createdBy: 'g8-probe',
  });
  templateBoundId = bound.templateId;
  const unbound = await createTemplate({
    tenantId: TENANT, orgId: ORG, name: 'G8 unbound', kind: 'doc', outputFormat: 'markdown',
    promptBody: 'Write a one-pager about {{topic}}.', createdBy: 'g8-probe',
  });
  templateUnboundId = unbound.templateId;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

function defFor(workflowId: string, templateId: string): WorkflowDefinition {
  return {
    workflowId,
    name: 'G8 emission probe',
    version: '1.0.0',
    nodes: [{
      nodeId: 'gen',
      typeId: 'feature.documents.nodes.generate-from-template',
      config: {},
      // Executor input entries are LITERALS passed through unchanged
      // (types.ts §inputs) — a {literal: x} wrapper arrives as an object and
      // stringifies to '', which presented as "Template not found."
      inputs: {
        templateId,
        orgId: ORG,
        provider: 'mock',
        parameters: { topic: 'conformance' },
      },
    }],
    edges: [],
  } as unknown as WorkflowDefinition;
}

async function runToCompletion(workflowId: string): Promise<{ status: string; events: Array<{ type: string; payload?: Record<string, unknown> }> }> {
  const create = await jsonFetch<{ runId: string }>('/v1/runs', {
    method: 'POST', body: JSON.stringify({ workflowId, tenantId: TENANT, inputs: {} }),
  });
  expect(create.status, `run create failed: ${JSON.stringify(create.body)}`).toBe(201);
  const { runId } = create.body;
  let status = 'running';
  for (let i = 0; i < 60 && (status === 'running' || status === 'pending'); i++) {
    await new Promise((r) => setTimeout(r, 250));
    const st = await jsonFetch<{ status: string }>(`/v1/runs/${runId}`);
    status = st.body.status;
  }
  const ev = await jsonFetch<{ events: Array<{ type: string; payload?: Record<string, unknown> }> }>(`/v1/runs/${runId}/events/poll?fromSeq=0&limit=200`);
  return { status, events: ev.body.events ?? [] };
}

describe('G8 — artifact.created emission from a real run', () => {
  it('a template BOUND to a registered artifact type emits artifact.created', async () => {
    registerWorkflow(defFor('g8.emission.bound', templateBoundId));
    const { status, events } = await runToCompletion('g8.emission.bound');
    const failedPayload = events.find((e) => e.type === 'node.failed')?.payload;
    expect(status, `run did not complete; node.failed: ${JSON.stringify(failedPayload)}`).toBe('completed');
    const created = events.filter((e) => e.type === 'artifact.created');
    expect(created.length, `no artifact.created among: ${events.map((e) => e.type).join(', ')}`).toBe(1);
    // The payload is the RFC 0071 substance — typed and marked registered.
    const p = created[0]!.payload ?? {};
    // Validate against the CANONICAL payload schema, not against the field names
    // this host happens to emit. The previous assertion read `p.artifactTypeId`
    // and was green for years while the event carried NEITHER required field
    // (`artifactId`, `artifactType`) — the RFC 0142 leg-B witness caught it on its
    // first real run. A test that mirrors the implementation cannot detect the
    // implementation being wrong about the contract.
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { corpusSchema } = await import('./support/corpusSchema.js');
    // From the PACKAGE, not the vendored copy (RFC 0145 G2).
    const defs = corpusSchema('run-event-payloads.schema.json');
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile((defs.$defs ?? {})['artifactCreated'] as object);
    expect(validate(p), `payload violates §artifactCreated: ${JSON.stringify(validate.errors ?? [])}`).toBe(true);
    expect(p.artifactType, 'the REQUIRED canonical field').toBe('doc.one-pager');
    expect(p.artifactTypeId, 'deprecated alias, retained for internal readers').toBe('doc.one-pager');
    expect(p.registered, 'type is host-native and MUST be marked registered').toBe(true);
    expect(p.valid, 'payload failed schema validation').toBe(true);
  });

  it('an UNBOUND template completes WITHOUT the event — the binding causes the emission', async () => {
    registerWorkflow(defFor('g8.emission.unbound', templateUnboundId));
    const { status, events } = await runToCompletion('g8.emission.unbound');
    expect(status).toBe('completed');
    expect(events.some((e) => e.type === 'artifact.created'), 'unbound template emitted artifact.created').toBe(false);
  });
});
