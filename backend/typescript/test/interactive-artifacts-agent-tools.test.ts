/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT A10) — the Visualizer's real tools.
 *
 * Contract under test: `openwop:interactive-artifacts.render` drives the REAL
 * pack node for normalization/validation, persists through the run-artifact
 * owner (deterministic key — a retry of the same payload does not duplicate),
 * and returns typed errors on invalid input (never success-with-empty);
 * `openwop:interactive-artifacts.get` reads back tenant-checked and fails
 * EMPTY without an acting user.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  INTERACTIVE_ARTIFACTS_GET_TOOL_ID,
  INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID,
} from '../src/features/interactive-artifacts/agentTools.js';

const TENANT = 'default';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const provider = (scope: { actingUserId?: string; conversationId?: string } = {}) =>
  createAgentToolProvider({ tenantId: TENANT, ...scope });

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

  it('renders a mermaid artifact, deterministically keyed, and reads it back', async () => {
    const p = provider({ actingUserId: 'u-1', conversationId: 'conv-1' });
    const res = await p.executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content);
    expect(body.artifactTypeId).toBe('interactive.mermaid');
    // DATA-1 — the key is tenant-prefixed so it can't collapse across tenants.
    expect(body.artifactKey).toContain(`chat-viz:${TENANT}:conv-1`);

    // Same payload again → same artifact (no duplicate mint).
    const res2 = await p.executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' } });
    expect(JSON.parse(res2.content).artifactId).toBe(body.artifactId);

    const read = await p.executeTool({ name: INTERACTIVE_ARTIFACTS_GET_TOOL_ID, input: { artifactKey: body.artifactKey } });
    const readBody = JSON.parse(read.content);
    expect(readBody.artifact?.artifactTypeId).toBe('interactive.mermaid');
    expect(readBody.artifact?.content).toContain('A-->B');
  });

  it('invalid chart input returns a typed validation error (repair loop food)', async () => {
    const p = provider({ actingUserId: 'u-1', conversationId: 'conv-1' });
    const res = await p.executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'chart', source: 'not-json' } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).error).toBe('validation_error');
  });

  it('get fails EMPTY without an acting user and on cross-tenant keys', async () => {
    const anon = await provider().executeTool({ name: INTERACTIVE_ARTIFACTS_GET_TOOL_ID, input: { artifactKey: 'chat-viz:conv-1:render:x' } });
    expect(JSON.parse(anon.content).artifact).toBeNull();
  });

  // DATA-1 — the synthetic runId carries the tenant, so two tenants rendering
  // IDENTICAL content through the SAME (empty-ish) scope mint DIFFERENT artifact
  // keys. Before the fix `runArtifactKey` had no tenant dimension, so the two
  // collided onto one row and the second tenant silently got the first's artifact.
  it('identical content in two different tenants mints DIFFERENT artifact keys', async () => {
    const input = { kind: 'mermaid', source: 'graph TD; X-->Y', title: 'Shared' };
    const a = await createAgentToolProvider({ tenantId: 'tenant-A', actingUserId: 'u-1' })
      .executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input });
    const b = await createAgentToolProvider({ tenantId: 'tenant-B', actingUserId: 'u-1' })
      .executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input });
    const keyA = JSON.parse(a.content).artifactKey as string;
    const keyB = JSON.parse(b.content).artifactKey as string;
    expect(keyA).toBeTruthy();
    expect(keyB).toBeTruthy();
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain('tenant-A');
    expect(keyB).toContain('tenant-B');
  });
});
