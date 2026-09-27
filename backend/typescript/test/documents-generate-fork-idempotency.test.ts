/**
 * PROBE-DOC-2 (falsifies WF-DOC-1) — the `generate-from-template` node's
 * replay/fork idempotency claim, executed against the REAL handler + REAL
 * surface + REAL service.
 *
 * The pack prose said "idempotency-keyed, replay-safe" while the handler passed
 * NO `documentId` to `createDocument`, so the service's replay short-circuit
 * never applied and every execution minted `doc:${randomUUID()}` — a `:fork`
 * produced a 2nd document + 2nd version + 2nd paid `ctx.callAI` +
 * 2nd `artifact.created`. Born-red witnessed: with the deterministic-id line
 * reverted, the first test counts TWO documents.
 *
 * Method per the probe spec: execute the handler twice with IDENTICAL
 * `ctx.runId`/`ctx.nodeId` (what a replay/fork does) and count the
 * `documents:doc` rows the org holds afterward.
 */
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { buildDocumentsSurface } from '../src/features/documents/surface.js';
import { createTemplate, listDocuments, listVersions } from '../src/features/documents/documentsService.js';
// The real pack handler — the unit under test. Direct import is the
// established pattern (adr0411-reel-node, ai-exchange-wave2, …).
import { generateFromTemplate } from '../../../packs/feature.documents.nodes/index.mjs';

const TENANT = 'org:doc-gen-fork';
let ORG = '';
let TEMPLATE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  ORG = org.orgId;
  const tmpl = await createTemplate({
    tenantId: TENANT, orgId: ORG, name: 'Fork probe', kind: 'doc', outputFormat: 'markdown',
    promptBody: 'Write a one-pager about {{topic}}.', createdBy: 'probe',
  });
  TEMPLATE = tmpl.templateId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** A ctx shaped like the executor's: same runId/nodeId = a replay/fork re-execution. */
function ctxFor(runId: string, nodeId: string, aiCalls: { n: number }): Record<string, unknown> {
  return {
    runId,
    nodeId,
    inputs: { orgId: ORG, templateId: TEMPLATE, params: { topic: 'replay' }, title: 'Fork probe doc', kind: 'doc' },
    features: { documents: buildDocumentsSurface({ tenantId: TENANT, runId }) },
    callAI: async () => {
      aiCalls.n += 1;
      return { content: 'Deterministic generated body.' };
    },
  };
}

describe('PROBE-DOC-2 — generate-from-template converges under re-execution', () => {
  it('two executions with identical runId/nodeId produce ONE document and ONE version', async () => {
    const aiCalls = { n: 0 };
    const first = (await generateFromTemplate(ctxFor('run-fork-1', 'gen', aiCalls))) as {
      status: string; outputs?: { document?: { documentId?: string }; version?: number };
    };
    expect(first.status, JSON.stringify(first)).toBe('success');
    const second = (await generateFromTemplate(ctxFor('run-fork-1', 'gen', aiCalls))) as {
      status: string; outputs?: { document?: { documentId?: string }; version?: number };
    };
    expect(second.status, JSON.stringify(second)).toBe('success');

    const rows = await listDocuments(TENANT, ORG);
    expect(rows.length, `expected ONE document, got ids: ${rows.map((d) => d.documentId).join(', ')}`).toBe(1);
    expect(second.outputs?.document?.documentId).toBe(first.outputs?.document?.documentId);

    // The version dedupes on the same idempotency key too — one immutable row.
    const versions = await listVersions(TENANT, ORG, String(first.outputs?.document?.documentId));
    expect(versions.length).toBe(1);
    expect(second.outputs?.version).toEqual(first.outputs?.version);
  });

  it('a DIFFERENT run still gets its own document (the id is per run/node, not global)', async () => {
    const aiCalls = { n: 0 };
    const other = (await generateFromTemplate(ctxFor('run-fork-2', 'gen', aiCalls))) as {
      status: string; outputs?: { document?: { documentId?: string } };
    };
    expect(other.status).toBe('success');
    const rows = await listDocuments(TENANT, ORG);
    expect(rows.length, 'the deterministic id must not collapse DISTINCT runs into one row').toBe(2);
  });
});
