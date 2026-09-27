/**
 * `DOCWF-1` — a template's `outputSchema` is ENFORCED on the lane a user can actually reach.
 *
 * BORN RED. `FEATURES.md` and `packs/feature.documents.nodes/pack.json` both advertise
 * "validates output against a template-owned `outputSchema`". The chat-tool lane —
 * `openwop:documents.generate-from-template`, the lane an agent invokes — read the schema ONLY
 * to report `hasOutputSchema: true` back to the model in `get-template`, then discarded it and
 * persisted `contentMarkdown` verbatim. So the model was TOLD a contract existed and it was
 * never applied, which is worse than silence: an agent can reasonably rely on being checked.
 *
 * And the lane that DID enforce it had no consumer — no chain under `examples/` references any
 * `feature.documents.nodes.*` typeId, verified by grep. The enforcing lane was unreachable; the
 * reachable lane had no contract. That is the promise-with-nothing-implementing-it shape this
 * repo's own CLAUDE.md records as having shipped before.
 *
 * The failure is a TYPED error carrying the reason, which the agent loop's one bounded repair
 * feeds back — the same shape the param check in this tool already used.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { DOCUMENTS_GENERATE_FROM_TEMPLATE_TOOL_ID } from '../src/features/documents/agentTools.js';
import { createTemplate, listDocumentsForTenant } from '../src/features/documents/documentsService.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';

const TENANT = 'default';
let server: http.Server;
let ORG = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const org = await createOrg({ tenantId: TENANT, name: 'DocSchema Org', createdBy: 'user:owner' });
  ORG = org.orgId;
  // The acting user needs write scope in the org — the tool's authz gate is real and fired on
  // the first draft of this fixture, which is the gate working, not a defect.
  await createMember({ tenantId: TENANT, orgId: ORG, displayName: 'Owner', subject: 'user:owner', roles: ['admin'] });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const run = async (input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> =>
  createAgentToolProvider({ tenantId: TENANT, runId: `run-docwf1-${Math.random().toString(16).slice(2, 8)}`, actingUserId: 'user:owner' })
    .executeTool({ name: DOCUMENTS_GENERATE_FROM_TEMPLATE_TOOL_ID, input });

describe('DOCWF-1 — the outputSchema contract is enforced where it is reachable', () => {
  it('BORN RED — content missing a required key is a TYPED failure, and nothing is persisted', async () => {
    const tmpl = await createTemplate({ tenantId: TENANT, orgId: ORG, name: 'SOW with schema', kind: 'sow', promptBody: 'Write a SOW.', outputFormat: 'markdown', outputSchema: { type: 'object', required: ['scope', 'deliverables'] }, createdBy: 'user:owner' });

    const before = (await listDocumentsForTenant(TENANT)).length;
    const out = await run({ templateId: tmpl.templateId, orgId: ORG, contentMarkdown: JSON.stringify({ scope: 'build it' }) });

    expect(out.isError, 'a schema violation must be an ERROR, not a silent success').toBe(true);
    const body = JSON.parse(out.content) as { error?: string; message?: string };
    expect(body.error).toBe('validation_error');
    // The message must NAME what is missing — it is the agent's one bounded repair input.
    expect(String(body.message ?? out.content)).toMatch(/deliverables/);

    // Nothing persisted: success-with-empty is the failure this closes.
    expect(await listDocumentsForTenant(TENANT), 'no document may be created on a rejected generation').toHaveLength(before);
  });

  it('content that is not JSON at all is refused when a schema is declared', async () => {
    const tmpl = await createTemplate({ tenantId: TENANT, orgId: ORG, name: 'Schema prose', kind: 'sow', promptBody: 'Write it.', outputFormat: 'markdown', outputSchema: { type: 'object', required: ['scope'] }, createdBy: 'user:owner' });
    const out = await run({ templateId: tmpl.templateId, orgId: ORG, contentMarkdown: '# Just prose, no JSON' });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/did not parse as JSON|outputSchema/);
  });

  it('a satisfying payload still succeeds — the gate must not block valid work', async () => {
    const tmpl = await createTemplate({ tenantId: TENANT, orgId: ORG, name: 'SOW ok', kind: 'sow', promptBody: 'Write a SOW.', outputFormat: 'markdown', outputSchema: { type: 'object', required: ['scope', 'deliverables'] }, createdBy: 'user:owner' });
    const out = await run({
      templateId: tmpl.templateId, orgId: ORG,
      contentMarkdown: JSON.stringify({ scope: 'build it', deliverables: ['a', 'b'] }),
    });
    expect(out.isError, out.content.slice(0, 300)).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ documentId: expect.any(String) });
  });

  it('a template with NO outputSchema is unaffected — prose still works', async () => {
    // The scope control. Seed templates deliberately carry no schema, so a gate that fired
    // unconditionally would break the default path.
    const tmpl = await createTemplate({ tenantId: TENANT, orgId: ORG, name: 'No schema', kind: 'sow', promptBody: 'Write it.', outputFormat: 'markdown', createdBy: 'user:owner' });
    const out = await run({ templateId: tmpl.templateId, orgId: ORG, contentMarkdown: '# Ordinary prose' });
    expect(out.isError, out.content.slice(0, 300)).toBeFalsy();
  });
});
