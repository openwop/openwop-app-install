/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT A10) — the Visualizer's real tools.
 *
 * Contract under test: `openwop:interactive-artifacts.render` drives the REAL
 * pack node for normalization/validation, persists through the run-artifact
 * owner (deterministic key — a retry of the same payload does not duplicate),
 * and returns typed errors on invalid input (never success-with-empty);
 * `openwop:interactive-artifacts.get` reads back tenant-checked and fails
 * EMPTY without an acting user.
 *
 * Red if render stops refusing an anonymous caller (`w27g2-iaat-render-auth`), the key
 * loses its tenant or determinism (`iaat-key-*`), validation errors stop being typed, or
 * get drops either guard — the acting-user check (`iaat-get-auth-r2`) or the record
 * tenant re-check (`iaat-get-tenant-r2`). The get case reads a key that REALLY EXISTS,
 * because `getRunArtifact` resolves by key alone: on a missing key both guards are moot.
 *
 * ADR 1017 — red also if: the render result carries the key / artifact id / tenant /
 * conversation into model text (D4); a payload the store would demote to an untyped
 * blob comes back as success (D3: schema-only refusals and the size cap); get reads a
 * WORKFLOW-RUN artifact by key, past the Library's org gate (D4/B3); or the chat
 * turn's message id is not stamped on the row (D2).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, createScopedAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  INTERACTIVE_ARTIFACTS_GET_TOOL_ID,
  INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID,
} from '../src/features/interactive-artifacts/agentTools.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { getRunArtifact, persistRunArtifact, runArtifactKey } from '../src/host/runArtifactStore.js';
import { chatArtifactRunId } from '../src/host/chatArtifactScope.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';
import { createMember } from '../src/host/accessControlService.js';

const TENANT = 'default';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // ADR 0996 — `get` reads a chat-viz artifact only for someone who may
  // read its conversation, so the conversations these cases render in are real,
  // owned by the acting user, the way the chat-sessions route records them.
  // ADR 1017 D4 — `get` now reads through the Library's gate, which asks org read
  // first, so the acting users are real workspace members (as they are in a chat).
  for (const subject of ['u-1', 'u-2']) await createMember({ tenantId: TENANT, orgId: TENANT, subject, displayName: subject, roles: ['viewer'] });
  const now = new Date().toISOString();
  for (const id of ['conv-1', 'conv-get']) {
    await hostExtStorage().createChatSession({ sessionId: id, tenantId: TENANT, title: id, createdAt: now, updatedAt: now, messageCount: 0 });
    await ensureConversationMeta(TENANT, id, { type: 'agent', ownerUserId: 'u-1' });
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const provider = (scope: { actingUserId?: string; conversationId?: string; turnMessageId?: string } = {}) =>
  createAgentToolProvider({ tenantId: TENANT, ...scope });

/** The row a render in `scope` wrote for `handle`, read straight from the store. */
const rowFor = (scope: { tenantId: string; conversationId?: string; actingUserId?: string }, handle: string) =>
  getRunArtifact(runArtifactKey(chatArtifactRunId('chat-viz', scope), handle));

describe('interactive-artifacts agent tools (CFP-1 / A10)', () => {
  it('registers both tools in the conversational universe', () => {
    const ids = builtinAgentToolIds();
    expect(ids).toContain(INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID);
    expect(ids).toContain(INTERACTIVE_ARTIFACTS_GET_TOOL_ID);
  });

  it('render fails TYPED without an acting user', async () => {
    const res = await provider().executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'mermaid', source: 'graph TD; A-->B' } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).error).toBe('auth_required');
  });

  it('renders a mermaid artifact under a content handle, deterministically, and reads it back', async () => {
    const p = provider({ actingUserId: 'u-1', conversationId: 'conv-1', turnMessageId: 'run-1:gate:0:3:agent' });
    const res = await p.executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' } });
    expect(res.isError, res.content).toBeFalsy();
    const body = JSON.parse(res.content);
    expect(body).toEqual({ handle: expect.stringMatching(/^render:[0-9a-f]{12}$/), artifactTypeId: 'interactive.mermaid', title: 'Flow' });
    // DATA-1 — the stored key is tenant- and conversation-scoped (it just isn't model text).
    const row = await rowFor({ tenantId: TENANT, conversationId: 'conv-1' }, body.handle);
    expect(row?.artifactKey).toBe(`chat-viz:${TENANT}:conv-1:${body.handle}`);
    // ADR 1017 D2 — the row names the chat turn that made it.
    expect(row?.turnMessageId).toBe('run-1:gate:0:3:agent');

    // Same payload again → same artifact (no duplicate mint), and BYTE-identical model
    // text: a replay fork re-running this call must not change the next round's digest.
    const res2 = await p.executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' } });
    expect(res2.content).toBe(res.content);

    const read = await p.executeTool({ name: INTERACTIVE_ARTIFACTS_GET_TOOL_ID, input: { artifactKey: body.handle } });
    const readBody = JSON.parse(read.content);
    expect(readBody.artifact?.artifactTypeId).toBe('interactive.mermaid');
    expect(readBody.artifact?.content).toContain('A-->B');
    expect(readBody.artifact?.handle).toBe(body.handle);
  });

  // ADR 1017 D2 — the chat transport builds its tools through the ONE scope composer
  // (ADR 0324); a field it drops never reaches the tool, and the card never shows.
  it('ADR 1017 D2: the turn message id survives the scope composer onto the row', async () => {
    const scope = { tenantId: TENANT, runId: 'conv-run-x', actingUserId: 'u-1', conversationId: 'conv-1', turnMessageId: 'conv-run-x:gate:0:7:agent' };
    const res = await createScopedAgentToolProvider(scope)
      .executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'mermaid', source: 'graph TD; Composer-->Row' } });
    expect(res.isError, res.content).toBeFalsy();
    expect((await rowFor(scope, JSON.parse(res.content).handle))?.turnMessageId).toBe('conv-run-x:gate:0:7:agent');
  });

  it('ADR 1017 D4: the render result is the same text in any tenant or conversation, and names neither', async () => {
    const input = { kind: 'mermaid', source: 'graph TD; R-->I', title: 'Indep' };
    const one = await createAgentToolProvider({ tenantId: 'tenant-R1', actingUserId: 'u-1', conversationId: 'conv-alpha' })
      .executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input });
    const two = await createAgentToolProvider({ tenantId: 'tenant-R2', actingUserId: 'u-9', conversationId: 'conv-beta' })
      .executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input });
    expect(one.isError, one.content).toBeFalsy();
    expect(two.content).toBe(one.content);
    for (const leak of ['tenant-R1', 'conv-alpha', 'u-1', 'chat-viz', 'run-event']) expect(one.content).not.toContain(leak);
  });

  it('invalid chart input returns a typed validation error (repair loop food)', async () => {
    const p = provider({ actingUserId: 'u-1', conversationId: 'conv-1' });
    const res = await p.executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'chart', source: 'not-json' } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).error).toBe('validation_error');
  });

  // ADR 1017 D3 — the node passes these, the registered SCHEMA refuses them. Before, the
  // store demoted each to an untyped JSON blob and the tool answered success with
  // `artifactTypeId: "interactive.chart"`.
  it('ADR 1017 D3: a payload only the schema refuses is a typed failure with the reasons, and nothing is stored', async () => {
    const scope = { actingUserId: 'u-1', conversationId: 'conv-1' };
    const chart = { chartType: 'bar', data: { datasets: [{ data: [1] }] }, legend: 'stray field' };
    const res = await provider(scope).executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'chart', chart } });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error).toBe('validation_error');
    expect(body.errors?.length).toBeGreaterThan(0);
    // The would-be key holds nothing (no demoted blob behind a "success").
    const { createHash } = await import('node:crypto');
    const handle = `render:${createHash('sha256').update(JSON.stringify({ k: 'chart', s: undefined, c: chart, t: undefined })).digest('hex').slice(0, 12)}`;
    expect(await rowFor({ tenantId: TENANT, ...scope }, handle)).toBeNull();
  });

  it('ADR 1017 D3: an over-cap payload is a typed too_large, not a reasonless persist failure', async () => {
    const res = await provider({ actingUserId: 'u-1', conversationId: 'conv-1' })
      .executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'html', source: `<p>${'x'.repeat(1_000_001)}</p>` } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).error).toBe('too_large');
  });

  it('get fails EMPTY without an acting user, for another tenant, and for a member who cannot read the conversation', async () => {
    // Its own artifact (own conversation + content), so the case stands alone under shuffle.
    const owner = provider({ actingUserId: 'u-1', conversationId: 'conv-get' });
    const made = await owner.executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'mermaid', source: 'graph TD; G-->H' } });
    expect(made.isError, made.content).toBeFalsy();
    const handle = JSON.parse(made.content).handle as string;
    const fullKey = `chat-viz:${TENANT}:conv-get:${handle}`;
    expect((await getRunArtifact(fullKey))?.tenantId).toBe(TENANT); // the key REALLY exists
    const get = (p: ReturnType<typeof createAgentToolProvider>, artifactKey: string) =>
      p.executeTool({ name: INTERACTIVE_ARTIFACTS_GET_TOOL_ID, input: { artifactKey } }).then((r) => JSON.parse(r.content));

    // positive controls: the owner reads it by handle AND by the legacy full key
    expect((await get(owner, handle)).artifact?.content).toContain('G-->H');
    expect((await get(provider({ actingUserId: 'u-1' }), fullKey)).artifact?.content).toContain('G-->H');
    // same tenant, NO acting user → empty
    expect(await get(provider(), fullKey)).toEqual({ artifact: null });
    // another tenant, authenticated, the same real key → empty
    expect(await get(createAgentToolProvider({ tenantId: 'tenant-other', actingUserId: 'u-2' }), fullKey)).toEqual({ artifact: null });
    // same tenant, another member who cannot read the conversation → empty (CE62-F1)
    expect(await get(provider({ actingUserId: 'u-2' }), fullKey)).toEqual({ artifact: null });
    // …and their handle resolves in THEIR bucket, not the owner's
    expect(await get(provider({ actingUserId: 'u-2', conversationId: 'conv-1' }), handle)).toEqual({ artifact: null });
  });

  // Code grade B1 — the org question is asked the run-lane way (ADR 0830 D1): the owner
  // of a personal tenant has NO member row, and must still read their own artifact
  // outside demo mode. Asked through the Library's resolver it answered "none".
  it('ADR 1017 D4: a personal-tenant owner reads their own artifact back (no member row)', async () => {
    const prev = process.env.OPENWOP_DEMO_MODE;
    process.env.OPENWOP_DEMO_MODE = 'false';
    try {
      const mine = createAgentToolProvider({ tenantId: 'user:solo-9', actingUserId: 'solo-9', personalTenant: 'user:solo-9' });
      const made = await mine.executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'mermaid', source: 'graph TD; Solo-->Me' } });
      expect(made.isError, made.content).toBeFalsy();
      const handle = JSON.parse(made.content).handle as string;
      const read = JSON.parse((await mine.executeTool({ name: INTERACTIVE_ARTIFACTS_GET_TOOL_ID, input: { artifactKey: handle } })).content);
      expect(read.artifact?.content).toContain('Solo-->Me');
      // …and nobody else can, through the legacy full key.
      const fullKey = `chat-viz:user:solo-9:user:solo-9:${handle}`;
      expect((await getRunArtifact(fullKey))?.tenantId).toBe('user:solo-9');
      const other = createAgentToolProvider({ tenantId: 'user:solo-9', actingUserId: 'intruder' });
      expect(JSON.parse((await other.executeTool({ name: INTERACTIVE_ARTIFACTS_GET_TOOL_ID, input: { artifactKey: fullKey } })).content)).toEqual({ artifact: null });
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_DEMO_MODE; else process.env.OPENWOP_DEMO_MODE = prev;
    }
  });

  // ADR 1017 D4 (/architect B3) — the old check was `record.tenantId` + a chat-bucket
  // rule that answers `true` for any NON-chat row, so the tool read every workflow-run
  // artifact in the tenant by key, past the Library's org gate.
  it('ADR 1017 B3: get cannot read a workflow-run artifact by key', async () => {
    await persistRunArtifact({ tenantId: TENANT, runId: 'run-wf-secret', nodeId: 'n1', role: 'deliverable', output: { text: 'client numbers' }, now: new Date().toISOString() });
    expect((await getRunArtifact('run-wf-secret:n1'))?.content).toContain('client numbers');
    const res = await provider({ actingUserId: 'u-1', conversationId: 'conv-1' })
      .executeTool({ name: INTERACTIVE_ARTIFACTS_GET_TOOL_ID, input: { artifactKey: 'run-wf-secret:n1' } });
    expect(JSON.parse(res.content)).toEqual({ artifact: null });
  });

  // DATA-1 — the synthetic runId carries the tenant, so two tenants rendering
  // IDENTICAL content through the SAME (empty-ish) scope write DIFFERENT rows. Before
  // the fix `runArtifactKey` had no tenant dimension, so the two collided onto one row
  // and the second tenant silently got the first's artifact.
  it('identical content in two different tenants writes DIFFERENT rows', async () => {
    const input = { kind: 'mermaid', source: 'graph TD; X-->Y', title: 'Shared' };
    const a = await createAgentToolProvider({ tenantId: 'tenant-A', actingUserId: 'u-1' })
      .executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input });
    const b = await createAgentToolProvider({ tenantId: 'tenant-B', actingUserId: 'u-1' })
      .executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input });
    const handle = JSON.parse(a.content).handle as string;
    expect(b.isError, b.content).toBeFalsy();
    const rowA = await rowFor({ tenantId: 'tenant-A', actingUserId: 'u-1' }, handle);
    const rowB = await rowFor({ tenantId: 'tenant-B', actingUserId: 'u-1' }, handle);
    expect(rowA?.tenantId).toBe('tenant-A');
    expect(rowB?.tenantId).toBe('tenant-B');
    expect(rowA?.artifactKey).not.toBe(rowB?.artifactKey);
  });
});
