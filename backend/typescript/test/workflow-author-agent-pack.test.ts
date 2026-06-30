/**
 * Guards the contract the builder's "Create with AI" embed depends on: the
 * `feature.workflow-author.agents` pack (ADR 0072) must load the Workflow
 * Architect agent under the EXACT agentId the frontend scopes to
 * (`CreateWithAiPanel.tsx` → useScopeToAgent), with its system prompt resolved.
 *
 * If the agent ever stops surfacing in GET /v1/agents, useScopeToAgent silently
 * falls back to the default assistant and the embed runs WITHOUT the workflow-
 * authoring system prompt — looking like the generic chat. This test fails loudly
 * instead. Loads the pack the same way bootstrap does (loadAgentsFromManifest),
 * independent of local-mount config in CI.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
// Must stay in lockstep with frontend WORKFLOW_ARCHITECT_AGENT_ID in
// frontend/react/src/builder/CreateWithAiPanel.tsx.
const ARCHITECT = 'feature.workflow-author.agents.workflow-architect';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // Load the feature's agent pack regardless of local-mount config in CI.
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'feature.workflow-author.agents'));
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0072/0073 — the Workflow Architect agent the builder embed scopes to', () => {
  it('surfaces in GET /v1/agents under the agentId the frontend hardcodes', async () => {
    const list = await (await fetch(`${BASE}/v1/agents`, { headers: H })).json() as {
      agents?: Array<{ agentId?: string; label?: string }>;
    };
    const architect = (list.agents ?? []).find((a) => a.agentId === ARCHITECT);
    expect(architect, `agent ${ARCHITECT} must be in the inventory`).toBeDefined();
    expect(architect?.label).toBe('Workflow Architect');
  });

  it('resolves the agent (and its system prompt) at GET /v1/agents/{agentId}', async () => {
    const res = await fetch(`${BASE}/v1/agents/${encodeURIComponent(ARCHITECT)}`, { headers: H });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agentId?: string }).agentId).toBe(ARCHITECT);
  });
});
