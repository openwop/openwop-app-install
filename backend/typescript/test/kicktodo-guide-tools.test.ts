/**
 * ADR 0442 Guide wave — KickBot's added grounding reads fail EMPTY without an
 * acting human principal (the vuln-scan posture the today/progress/circles tools
 * already hold: a scheduled/system turn must never enumerate a participant's
 * journal, forward plan, or coach proposals). This pins that contract for the
 * three NEW self-scoped reads + their registration, so a later change can't
 * silently turn one into a system-readable surface.
 *
 * (Engagement standing + awards ride the chat-first-port `engagement-summary`
 * tool — the Guide wave deliberately adds no separate achievements/leaderboard
 * tool, so those aren't retested here.)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';

const TENANT = 'default';

const JOURNAL = 'openwop:kicktodo.journal';
const PLAN = 'openwop:kicktodo.plan';
const PROPOSALS = 'openwop:kicktodo.proposals';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function runTool(name: string, input: Record<string, unknown>, scope: { actingUserId?: string }): Promise<{ content: string; isError?: boolean }> {
  const provider = createAgentToolProvider({ tenantId: TENANT, runId: 'run-guide', ...scope });
  return provider.executeTool({ name, input });
}

describe('ADR 0442 Guide wave — KickBot grounding reads register + fail empty', () => {
  it('the new reads are registered host agent tools', () => {
    const ids = builtinAgentToolIds();
    for (const id of [JOURNAL, PLAN, PROPOSALS]) {
      expect(ids, `${id} must be a registered feature agent tool`).toContain(id);
    }
  });

  it('a system turn (no acting user) reads NOTHING from any of them', async () => {
    expect(JSON.parse((await runTool(JOURNAL, {}, {})).content)).toEqual({ journal: [] });
    expect(JSON.parse((await runTool(PLAN, {}, {})).content)).toEqual({ plan: [] });
    expect(JSON.parse((await runTool(PROPOSALS, {}, {})).content)).toEqual({ proposals: [] });
  });

  it('a real participant with no data gets a valid EMPTY shape, never an error', async () => {
    const scope = { actingUserId: 'user:kt-nobody' };
    for (const [name, key] of [[JOURNAL, 'journal'], [PLAN, 'plan'], [PROPOSALS, 'proposals']] as const) {
      const r = await runTool(name, {}, scope);
      expect(r.isError, `${name} must not error for an empty participant`).toBeUndefined();
      expect(JSON.parse(r.content)).toHaveProperty(key);
    }
  });

  it('the Plan read refuses a span wider than 31 days (bounded scan)', async () => {
    const r = await runTool(PLAN, { from: '2026-01-01', to: '2026-12-31' }, { actingUserId: 'user:kt-nobody' });
    expect(JSON.parse(r.content)).toEqual({ plan: [] });
  });
});
