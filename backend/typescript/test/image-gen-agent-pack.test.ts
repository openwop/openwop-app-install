/**
 * ADR 0115 Phase 6 — the Image Generator agent pack.
 * The persona must surface under its exact agentId with the image-generate node in
 * its toolAllowlist (so chat can drive text-to-image).
 *
 * CORRECTED (wave 71): the allowlist is now EMPTY (CFP-1, see case 2), and this
 * file loads the pack ITSELF (`loadAgentsFromManifest` below). So it pins the
 * pack's listing through the real agents route and its empty allowlist — not
 * that the app mounts the pack at boot. TST-DGC-3. Red when the pack's label
 * changes (sabotage-witnessed, wave 71).
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
// test dir = <repo>/backend/typescript/test → up 3 to the repo root (packs/ live there).
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const AGENT = 'vendor.openwop-app.image-gen.agents.default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'vendor.openwop-app.image-gen.agents'));
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0115 Phase 6 — Image Generator agent pack', () => {
  it('surfaces in GET /v1/agents under its agentId', async () => {
    const list = await (await fetch(`${BASE}/agents`, { headers: H })).json() as { agents?: Array<{ agentId?: string; label?: string; persona?: string; modelClass?: string }> };
    const agent = (list.agents ?? []).find((a) => a.agentId === AGENT);
    expect(agent, `agent ${AGENT} must be in the inventory`).toBeDefined();
    expect(agent?.label).toBe('Image Generator');
    expect(agent?.persona).toBe('Image Generator');
    expect(agent?.modelClass).toBe('general');
  });

  it('resolves at GET /v1/agents/{id} + carries no phantom chat tools (manifest)', async () => {
    const res = await fetch(`${BASE}/agents/${encodeURIComponent(AGENT)}`, { headers: H });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agentId?: string }).agentId).toBe(AGENT);
    // CFP-1: `core.openwop.ai.image-generate` is a NODE, never a conversational
    // tool — no provider projected it, so the old allowlist entry was a lie to
    // the model. Image generation is deliberately a media-path / workflow-node
    // capability (unchanged); the agent is now a prompt-composer guide with no
    // chat tools. Its allowlist is therefore empty.
    const pack = JSON.parse(readFileSync(join(REPO_ROOT, 'packs', 'vendor.openwop-app.image-gen.agents', 'pack.json'), 'utf8')) as { agents: Array<{ toolAllowlist?: string[] }> };
    expect(pack.agents[0]!.toolAllowlist ?? []).toEqual([]);
  });
});
