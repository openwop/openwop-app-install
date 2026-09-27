/**
 * ADR 0488 P6 — the Tutor pack must LOAD, not merely parse.
 *
 * `tutorials-agent-tools.test.ts` mocks the registry to test tool behaviour;
 * that mock cannot tell you the pack manifest is well-formed enough for the real
 * loader. ADR 0442 is the cautionary tale: synthetic-registry tests MASKED a
 * production pack-loader bug (draft-07 vs Ajv2020 + a shared `$id`) for a whole
 * phase, and the failure only surfaced in prod. So this loads the pack exactly
 * as bootstrap does and asserts the agent reaches the live inventory.
 *
 * It also pins the two things that silently break the chat lane:
 *  - the agentId, which any deep-link (`/?agent=<id>`) must match;
 *  - the tool ALLOWLIST, which must name tools that actually register — an
 *    allowlist entry for a phantom tool leaves the Tutor unable to read anything
 *    while still looking configured.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { builtinAgentToolIds } from '../src/host/agentToolProvider.js';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
// backend/typescript/test → repo root is three levels up.
const PACK_DIR = join(import.meta.dirname, '..', '..', '..', 'packs', 'feature.tutorials.agents');
const TUTOR = 'feature.tutorials.agents.tutor';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  loadAgentsFromManifest(PACK_DIR);
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0488 P6 — the Tutor agent pack', () => {
  it('surfaces in the live agent inventory under its published id', async () => {
    const list = await (await fetch(`${BASE}/v1/agents`, { headers: H })).json() as {
      agents?: Array<{ agentId?: string; label?: string }>;
    };
    const tutor = (list.agents ?? []).find((a) => a.agentId === TUTOR);
    expect(tutor, `agent ${TUTOR} must be in the inventory`).toBeDefined();
    expect(tutor?.label).toBe('Tutor');
  });

  it('resolves with its system prompt at GET /v1/agents/{agentId}', async () => {
    const res = await fetch(`${BASE}/v1/agents/${encodeURIComponent(TUTOR)}`, { headers: H });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agentId?: string }).agentId).toBe(TUTOR);
  });

  it('every allowlisted tool REGISTERS — an allowlist of phantoms reads as configured but cannot see anything', () => {
    const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as {
      agents: Array<{ agentId: string; toolAllowlist: string[] }>;
    };
    const allowlist = manifest.agents.find((a) => a.agentId === TUTOR)!.toolAllowlist;
    expect(allowlist.length, 'non-vacuous — an empty allowlist would pass trivially').toBeGreaterThan(0);
    const known = new Set(builtinAgentToolIds());
    for (const id of allowlist) expect(known, `allowlisted tool ${id} does not register`).toContain(id);
  });

  it('the Tutor is allowlisted to READ tools only — no write tool sneaks in', () => {
    const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as {
      agents: Array<{ agentId: string; toolAllowlist: string[] }>;
    };
    const allowlist = manifest.agents.find((a) => a.agentId === TUTOR)!.toolAllowlist;
    // The delegate projection is a GUIDE. A write tool here would let it mutate
    // a workspace on a learner's behalf with no gate, which is not what was
    // reviewed or what the ADR describes.
    for (const id of allowlist) expect(id).toMatch(/^openwop:tutorials\.(catalog|get)$/);
  });

  it('the system prompt states the Tutor cannot launch a walkthrough', () => {
    // The single most likely hallucination on this surface is "I started it for
    // you". A backend turn has no live player; the prompt must pre-empt it.
    const prompt = readFileSync(join(PACK_DIR, 'prompts', 'tutor.md'), 'utf8').toLowerCase();
    expect(prompt).toMatch(/cannot start a walkthrough/);
    expect(prompt).toMatch(/never imply you launched/);
  });
});
