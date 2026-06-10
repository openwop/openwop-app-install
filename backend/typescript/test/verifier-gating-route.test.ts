/**
 * W-2 / RFC 0090 — the `verifier-gating` behavioral contract over HTTP. Boots the
 * real app with the verifier ladder enabled and exercises
 * POST /v1/host/sample/agents/verify-run:
 *   - discovery advertises executionModel.version 6 + verifier{supported,gating}
 *   - simulateVerdict 'pass' → commit (status 'completed'); agent.verified emitted
 *   - simulateVerdict 'fail' → commit BLOCKED (status != 'completed'); agent.verified
 *   - the agent.verified events are content-free (verifier-no-content-leak)
 *   - 404 (soft-skip) when the host does not advertise the verifier
 * Mirrors the steward-authored openwop `verifier-gating.test.ts` seam contract so
 * the reference host passes it non-vacuously under OPENWOP_REQUIRE_BEHAVIOR.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';

const PORT = 18262;
const BASE = `http://127.0.0.1:${PORT}`;
const H = { authorization: 'Bearer sample-token', 'content-type': 'application/json' };
const URL = `${BASE}/v1/host/sample/agents/verify-run`;

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // The RFC 0090 v6 ladder: execution-model on + phase5 (stateful loop) + verifier.
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL = 'true';
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5 = 'true';
  process.env.OPENWOP_AGENT_VERIFIER_GATING = 'true';
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const post = (body: unknown) => fetch(URL, { method: 'POST', headers: H, body: JSON.stringify(body) });

interface VerifyResp {
  status?: string; committed?: boolean; outcome?: string; verdict?: string;
  events?: Array<{ type?: string; verdict?: string; [k: string]: unknown }>;
}

describe('RFC 0090 — verifier-gating seam', () => {
  it('advertises executionModel.version 6 + verifier{supported,gating}', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      multiAgent?: { executionModel?: { version?: number; verifier?: { supported?: boolean; gating?: boolean } } };
      capabilities?: { multiAgent?: { executionModel?: { version?: number; verifier?: { supported?: boolean; gating?: boolean } } } };
    };
    const em = doc.multiAgent?.executionModel ?? doc.capabilities?.multiAgent?.executionModel;
    expect(em?.version).toBe(6);
    expect(em?.verifier?.supported).toBe(true);
    expect(em?.verifier?.gating).toBe(true);
  });

  it("commits on a 'pass' verdict and emits agent.verified", async () => {
    const res = await post({ simulateVerdict: 'pass' });
    expect(res.status).toBe(200);
    const body = await res.json() as VerifyResp;
    expect(body.status).toBe('completed');
    expect(body.committed).toBe(true);
    const verified = (body.events ?? []).filter((e) => e.type === 'agent.verified');
    expect(verified).toHaveLength(1);
    expect(verified[0]?.verdict).toBe('pass');
  });

  it("BLOCKS the commit on a 'fail' verdict (gating)", async () => {
    const res = await post({ simulateVerdict: 'fail' });
    expect(res.status).toBe(200);
    const body = await res.json() as VerifyResp;
    expect(body.status).not.toBe('completed');
    expect(body.committed).toBe(false);
    const verified = (body.events ?? []).filter((e) => e.type === 'agent.verified');
    expect(verified).toHaveLength(1);
    expect(verified[0]?.verdict).toBe('fail');
  });

  it('emits content-free agent.verified (verifier-no-content-leak)', async () => {
    const body = await (await post({ simulateVerdict: 'pass', task: 'SENSITIVE-PROMPT-12345' })).json() as VerifyResp;
    const verified = (body.events ?? []).find((e) => e.type === 'agent.verified');
    expect(JSON.stringify(verified)).not.toContain('SENSITIVE-PROMPT-12345');
    expect(JSON.stringify(verified)).not.toContain('candidate result');
  });

  it('404s (soft-skip) when the verifier is not advertised', async () => {
    delete process.env.OPENWOP_AGENT_VERIFIER_GATING;
    const res = await post({ simulateVerdict: 'pass' });
    expect(res.status).toBe(404);
    process.env.OPENWOP_AGENT_VERIFIER_GATING = 'true'; // restore for any later tests
  });
});
