/**
 * ADR 0114 Phase 6 — the Code Interpreter agent pack.
 * The persona must load under its exact agentId with its system prompt resolved +
 * the code-exec node in its toolAllowlist (so chat can drive sandboxed execution).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
// test dir = <repo>/backend/typescript/test → up 3 to the repo root (where packs/ live).
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const AGENT = 'feature.code-exec.agents.default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'feature.code-exec.agents'));
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0114 Phase 6 — Code Interpreter agent pack', () => {
  it('surfaces in GET /v1/agents under its agentId', async () => {
    const list = await (await fetch(`${BASE}/v1/agents`, { headers: H })).json() as { agents?: Array<{ agentId?: string; label?: string }> };
    const agent = (list.agents ?? []).find((a) => a.agentId === AGENT);
    expect(agent, `agent ${AGENT} must be in the inventory`).toBeDefined();
    expect(agent?.label).toBe('Code Interpreter');
  });

  it('resolves the agent at GET /v1/agents/{id}', async () => {
    const res = await fetch(`${BASE}/v1/agents/${encodeURIComponent(AGENT)}`, { headers: H });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agentId?: string }).agentId).toBe(AGENT);
  });

  it('declares the code-exec node in its toolAllowlist + a resolvable prompt (pack manifest)', () => {
    const pack = JSON.parse(readFileSync(join(REPO_ROOT, 'packs', 'feature.code-exec.agents', 'pack.json'), 'utf8')) as {
      agents: Array<{ toolAllowlist?: string[]; systemPromptRef?: string }>;
    };
    expect(pack.agents[0]!.toolAllowlist).toContain('openwop:feature.code-exec.nodes.run');
    expect(pack.agents[0]!.systemPromptRef).toBe('prompts/code-interpreter.md');
    // the referenced prompt file exists + names the persona
    const prompt = readFileSync(join(REPO_ROOT, 'packs', 'feature.code-exec.agents', 'prompts', 'code-interpreter.md'), 'utf8');
    expect(prompt).toContain('Code Interpreter');
  });
});
