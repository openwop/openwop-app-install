/**
 * CFP-1 repair — the Workflow Architect's chat tools resolve and behave.
 *
 * The bug (CHAT-FIRST-PORT-AUDIT #1, docs/chat-first-port/b1-workflow-author.md):
 * the `feature.workflow-author.agents` pack allowlisted node typeIds that NO host
 * registrant provided, so `compileAgentTools` silently dropped them and the
 * Architect ran in the ONE chat with zero tools. This asserts the four tools now
 * REGISTER into the builtin surface (so the allowlist resolves) and behave: the
 * `draft` catalog read, the `get` read-before-write (fail-empty without a user),
 * closed-world `validate` (the repair-loop feedback), and the `persist` write
 * (fail-typed without a user; registers through the shared validator/registry).
 *
 * Boots the REAL app — the ADR 0308 D2 registration seam is what's under test.
 *
 * @see docs/chat-first-port/b1-workflow-author.md
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { buildWorkflowAuthorSurface } from '../src/features/workflow-author/surface.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import {
  WORKFLOW_AUTHOR_DRAFT_TOOL_ID,
  WORKFLOW_AUTHOR_GET_TOOL_ID,
  WORKFLOW_AUTHOR_VALIDATE_TOOL_ID,
  WORKFLOW_AUTHOR_PERSIST_TOOL_ID,
} from '../src/features/workflow-author/agentTools.js';

const TENANT = 'default';
const USER = 'u-1';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

/** A minimal closed-world workflow — `core.noop` is a registered core node, so
 *  it is a legal catalog typeId in the booted app (the service test precedent). */
const noopWorkflow = (id: string) => ({
  workflowId: id,
  nodes: [{ nodeId: 'n1', typeId: 'core.noop', outputRole: 'primary' as const }],
});

describe('CFP-1 — the agents pack allowlist resolves to the four registered tools', () => {
  const packDir = new URL('../../../packs/feature.workflow-author.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as {
    agents: { toolAllowlist: string[]; systemPromptRef: string }[];
  };

  it('all four workflow-author tools register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    for (const id of [
      WORKFLOW_AUTHOR_DRAFT_TOOL_ID,
      WORKFLOW_AUTHOR_GET_TOOL_ID,
      WORKFLOW_AUTHOR_VALIDATE_TOOL_ID,
      WORKFLOW_AUTHOR_PERSIST_TOOL_ID,
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('every allowlist entry is offerable at dispatch (no toothless entry)', () => {
    const universe = new Set(builtinAgentToolIds());
    for (const entry of manifest.agents[0]!.toolAllowlist) {
      expect(universe.has(entry), `allowlist entry ${entry} resolves to a real tool`).toBe(true);
    }
  });
});

describe('CFP-1 — draft: the closed-world catalog read', () => {
  it('returns the node catalog (nodes + excluded), no acting user needed (public menu)', async () => {
    const out = await provider().executeTool({ name: WORKFLOW_AUTHOR_DRAFT_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { nodes: { typeId: string }[]; excluded: unknown[] };
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes.length).toBeGreaterThan(0);
    expect(parsed.nodes.some((n) => n.typeId === 'core.noop')).toBe(true);
  });
});

describe('CFP-1 — get: read-before-write (fail-empty without a human)', () => {
  it('fails EMPTY without an acting user (a system turn cannot enumerate workflows)', async () => {
    const out = await provider().executeTool({ name: WORKFLOW_AUTHOR_GET_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ found: false, workflows: [] });
  });

  it('with an acting user and no id, lists the registered-workflow index', async () => {
    const out = await provider({ actingUserId: USER }).executeTool({ name: WORKFLOW_AUTHOR_GET_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(Array.isArray((JSON.parse(out.content) as { workflows: unknown[] }).workflows)).toBe(true);
  });

  it('an unknown id is a structured not-found (never a throw)', async () => {
    const out = await provider({ actingUserId: USER }).executeTool({
      name: WORKFLOW_AUTHOR_GET_TOOL_ID,
      input: { workflowId: 'authored.does-not-exist' },
    });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ found: false });
  });
});

describe('CFP-1 — validate: closed-world re-check (the repair loop)', () => {
  it('accepts a candidate built only from catalog typeIds', async () => {
    const out = await provider({ actingUserId: USER }).executeTool({
      name: WORKFLOW_AUTHOR_VALIDATE_TOOL_ID,
      input: { definition: noopWorkflow('authored.validate-ok') },
    });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ ok: true, errors: [] });
  });

  it('returns closed-world errors for an invented typeId (never success-with-empty)', async () => {
    const out = await provider({ actingUserId: USER }).executeTool({
      name: WORKFLOW_AUTHOR_VALIDATE_TOOL_ID,
      input: { definition: { workflowId: 'authored.bad', nodes: [{ nodeId: 'n1', typeId: 'totally.made.up' }] } },
    });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { ok: boolean; errors: string[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(' ')).toContain('totally.made.up');
  });

  it('missing `definition` is a TYPED input error (the agent loop repairs)', async () => {
    const out = await provider({ actingUserId: USER }).executeTool({ name: WORKFLOW_AUTHOR_VALIDATE_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error' });
  });
});

describe('CFP-1 — persist: the governed write', () => {
  it('requires a human-initiated turn (fail TYPED without an acting user)', async () => {
    const out = await provider().executeTool({
      name: WORKFLOW_AUTHOR_PERSIST_TOOL_ID,
      input: { definition: noopWorkflow('authored.persist-nouser') },
    });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('registers a valid definition through the shared path and reads back via get', async () => {
    const p = provider({ actingUserId: USER });
    const id = 'authored.persist-ok';
    const persisted = await p.executeTool({ name: WORKFLOW_AUTHOR_PERSIST_TOOL_ID, input: { definition: noopWorkflow(id) } });
    expect(persisted.isError).toBeFalsy();
    const res = JSON.parse(persisted.content) as { workflowId: string; nodeCount: number; url: string };
    expect(res.workflowId).toBe(id);
    expect(res.nodeCount).toBe(1);
    expect(res.url).toBe(`/builder/${encodeURIComponent(id)}`);

    // The read side sees the write — the Architect's get tool grounds on it.
    const got = await p.executeTool({ name: WORKFLOW_AUTHOR_GET_TOOL_ID, input: { workflowId: id } });
    expect(JSON.parse(got.content)).toMatchObject({ found: true, definition: { workflowId: id } });
  });

  it('an invalid definition fails TYPED with the closed-world defect (never registers)', async () => {
    const out = await provider({ actingUserId: USER }).executeTool({
      name: WORKFLOW_AUTHOR_PERSIST_TOOL_ID,
      input: { definition: { workflowId: 'authored.persist-bad', nodes: [{ nodeId: 'n1', typeId: 'made.up' }] } },
    });
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content) as { error: string; message: string };
    expect(parsed.error).toBe('validation_error');
    expect(parsed.message).toContain('made.up');
  });
});

// ── CHAT-FIRST-PORT-AUDIT B1 / review HIGH-2 — the authoring lane is now
//    tenant-isolated through the ADR 0163 ownership layer, on BOTH the chat
//    tool path AND the meta-workflow surface path. ────────────────────────────
const A = 'ws-owner-a';
const B = 'ws-intruder-b';
const OWNER = 'u-owner';
const tool = (tenantId: string, actingUserId?: string) =>
  createAgentToolProvider({ tenantId, ...(actingUserId ? { actingUserId } : {}) });
const persist = (tenantId: string, id: string) =>
  tool(tenantId, OWNER).executeTool({ name: WORKFLOW_AUTHOR_PERSIST_TOOL_ID, input: { definition: noopWorkflow(id) } });
const getById = (tenantId: string, id: string) =>
  tool(tenantId, OWNER).executeTool({ name: WORKFLOW_AUTHOR_GET_TOOL_ID, input: { workflowId: id } });
const index = async (tenantId: string): Promise<string[]> => {
  const out = await tool(tenantId, OWNER).executeTool({ name: WORKFLOW_AUTHOR_GET_TOOL_ID, input: {} });
  return (JSON.parse(out.content) as { workflows: { workflowId: string }[] }).workflows.map((w) => w.workflowId);
};

describe('B1/HIGH-2 — persist/get are scoped to the owning tenant', () => {
  const w1 = 'authored.owned-by-a';

  it('tenant A persists w1 (records ownership)', async () => {
    const out = await persist(A, w1);
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ workflowId: w1 });
  });

  it('tenant B CANNOT overwrite w1 — typed conflict (and A still owns the original)', async () => {
    const out = await persist(B, w1);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'conflict', reason: 'owned_by_other_tenant', workflowId: w1 });
  });

  it('tenant B get w1 → indistinguishable not-found (no existence oracle)', async () => {
    const out = await getById(B, w1);
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ found: false });
  });

  it("tenant B's index excludes w1", async () => {
    expect(await index(B)).not.toContain(w1);
  });

  it('tenant A still sees w1 by id AND in its index', async () => {
    expect(JSON.parse((await getById(A, w1)).content)).toMatchObject({ found: true, definition: { workflowId: w1 } });
    expect(await index(A)).toContain(w1);
  });
});

describe('B1/HIGH-2 — built-ins are readable by all, overwritable by none', () => {
  // A host system def: registered at boot via registerWorkflow with NO ownership
  // row (the ADR 0440 P4 shape). Simulate one directly.
  const builtin = 'openwop-app.builtin-fixture';
  beforeAll(() => registerWorkflow(noopWorkflow(builtin)));

  it('any tenant may READ a built-in and it appears in the tenant index', async () => {
    expect(JSON.parse((await getById(B, builtin)).content)).toMatchObject({ found: true, definition: { workflowId: builtin } });
    expect(await index(B)).toContain(builtin);
  });

  it('a persist onto a built-in id is a typed conflict (never poisons the shared def)', async () => {
    const out = await persist(B, builtin);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'conflict', reason: 'builtin_workflow', workflowId: builtin });
  });
});

describe('B1/HIGH-2 — the meta-workflow SURFACE path enforces the same guards', () => {
  const scope = (tenantId: string): BundleScope => ({ tenantId, actingUserId: OWNER });
  const wSurf = 'authored.surface-owned-by-a';

  it('surface persist records ownership; a foreign surface CANNOT overwrite or read it', async () => {
    const sA = buildWorkflowAuthorSurface(scope(A));
    const sB = buildWorkflowAuthorSurface(scope(B));

    const persisted = await sA.persistDraft({ definition: noopWorkflow(wSurf) });
    expect(persisted).toMatchObject({ workflowId: wSurf });

    await expect(sB.persistDraft({ definition: noopWorkflow(wSurf) })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'owned_by_other_tenant' },
    });
    expect(await sB.getWorkflow({ workflowId: wSurf })).toEqual({ found: false });
    expect(await sA.getWorkflow({ workflowId: wSurf })).toMatchObject({ found: true, definition: { workflowId: wSurf } });
    // The scoped listWorkflows never leaks the owner's authored workflow to B.
    const bList = (await sB.listWorkflows({})).workflows as { workflowId: string }[];
    expect(bList.some((w) => w.workflowId === wSurf)).toBe(false);
  });
});
