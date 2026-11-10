/**
 * ADR 1045 push follow-up / RFC 0214 §A–§C — an A2A push carries the
 * destination credential the client registered, a 3xx is a failed delivery that
 * is never followed, and the credential appears in no log, response or outcome.
 *
 * Real code end to end: the 1.0 and 0.3 JSON-RPC handlers register the config,
 * the production `DurableCollection` stores it (memory storage, a local-AES KMS
 * client so the sealed form is the production KMS envelope), `upsertA2aTask`
 * fires the production sink `deliverA2aPush`, and undici's real `fetch` makes
 * the request. Only the socket is replaced: an undici `MockAgent` is passed as
 * the dispatcher, so the redirect decision is undici's own, not a stub's.
 *
 * The sentinel credential uses a custom scheme and no hex run, so the logger's
 * SEC-8 scrubber (which masks `Bearer …` and long hex) cannot hide a leak: a
 * "not in the logs" pass here means the code did not log it, not that the
 * backstop caught it.
 *
 * Sabotage-witnessed 2026-11-03, each reverted and the file re-run green:
 *  - delete `headers.authorization = …` in `deliverA2aPush` → the two
 *    "carries the credential" cases red (header undefined).
 *  - delete `redirect: 'manual'` → the 3xx case red (the redirect target is
 *    hit once; undici followed the 307).
 *  - add `authorization: target.authorization` to the outcome and the
 *    `a2a_push_delivery_failed` log fields → the "never in logs or outcomes"
 *    case red.
 *  - make `sealPushAuthorization` return the plaintext under KMS → the "held
 *    sealed" assertion red.
 *  - delete the terminal-state strip in `upsertA2aTask` → the "discarded on
 *    terminal" assertion red.
 *
 * Re-witnessed w86 grade-tests (2026-11-05), ten probes: the header line, an
 * added signature header, `follow` redirects, the 3xx branch, the plaintext
 * seal, the CRLF credential check, the auth-over-token precedence, the
 * terminal strip, and the URL or credential added to the failure log.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent } from 'undici';
import { handleA2aRequest10 } from '../src/host/a2aServer10.js';
import { handleA2aRequest } from '../src/host/a2aServer.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { openStorage } from '../src/storage/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import type { A2aPrincipal, A2aServiceDeps } from '../src/host/a2aService.js';
import {
  __resetA2aTaskStore,
  getA2aTask,
  setA2aPushSink,
  type A2aPushOutcome,
} from '../src/host/a2aTaskStore.js';
import { deliverA2aPush } from '../src/host/a2aPushDelivery.js';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';

const ORIGIN = 'https://receiver.example.com';
const TARGET = 'https://elsewhere.example.net';
const SCHEME = 'Token';
const SENTINEL = 'zq-push-sentinel-credential-Kx';

const ALICE: A2aPrincipal = { tenantId: 'tenant-alice', principalId: 'p-alice', protocolVersion: '1.0' };

let deps: A2aServiceDeps;
let agent: MockAgent;
let originHits: Array<{ path: string; headers: Record<string, string> }>;
let targetHits: number;
let originStatus: number;
let outcomes: A2aPushOutcome[];
let logged: string[];

function lowerHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) {
    for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
  } else if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

beforeAll(async () => {
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  deps = { storage, hostSuite: createHostAdapterSuite({ storage }) };
  configureKmsClient(createLocalAesKmsClient(randomBytes(32)));
});

afterAll(() => {
  delete process.env.OPENWOP_A2A_DURABLE_TASKS;
  _resetKmsForTesting();
});

beforeEach(async () => {
  await __resetA2aTaskStore();
  originHits = [];
  targetHits = 0;
  originStatus = 204;
  outcomes = [];
  logged = [];
  agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(ORIGIN)
    .intercept({ path: (p: string) => p.startsWith('/hook'), method: 'POST' })
    .reply((opts) => {
      originHits.push({ path: String(opts.path), headers: lowerHeaders(opts.headers) });
      return originStatus === 307
        ? { statusCode: 307, data: '', responseOptions: { headers: { location: `${TARGET}/stolen` } } }
        : { statusCode: originStatus, data: '' };
    })
    .persist();
  agent
    .get(TARGET)
    .intercept({ path: () => true, method: () => true })
    .reply(() => {
      targetHits += 1;
      return { statusCode: 200, data: '' };
    })
    .persist();
  // The production sink, with only the socket swapped.
  setA2aPushSink(async (target, event) => {
    const o = await deliverA2aPush(target, event, { dispatcher: agent });
    outcomes.push(o);
    return o;
  });
  const capture = (chunk: unknown): boolean => {
    logged.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setA2aPushSink(null);
  getAgentRegistry()._resetForTest();
  await agent.close();
});

async function send10(method: string, params: Record<string, unknown>) {
  return handleA2aRequest10(
    { jsonrpc: '2.0', id: 1, method, params },
    { agentCard: {}, principal: ALICE, deps },
  );
}

/** Open a real 1.0 task (a real run) and register a push config with a credential. */
async function taskWithPush(extra: Record<string, unknown>): Promise<{ taskId: string; created: unknown }> {
  const sent = await send10('SendMessage', {
    message: { messageId: `m-${randomBytes(4).toString('hex')}`, role: 'ROLE_USER', parts: [{ text: 'hi' }] },
  });
  const taskId = (sent.result as { task?: { id?: string } } | undefined)?.task?.id ?? '';
  expect(taskId, 'fixture: SendMessage opened no task').not.toBe('');
  const created = await send10('CreateTaskPushNotificationConfig', { taskId, url: `${ORIGIN}/hook`, ...extra });
  expect(created.error, `fixture: Create refused ${JSON.stringify(created.error)}`).toBeUndefined();
  return { taskId, created };
}

/**
 * Complete the backing run, then read the task: `GetTask` re-projects from the
 * live run (`refreshTaskFromRun` → `upsertA2aTask`), which is how a real
 * terminal transition reaches the push in production.
 */
async function finishRun(taskId: string): Promise<void> {
  await deps.storage.updateRun(taskId, { status: 'completed' });
  const read = await send10('GetTask', { id: taskId });
  expect(read.error).toBeUndefined();
}

describe('RFC 0214 §A/§C — the push carries the registered destination credential', () => {
  it('1.0 `authentication` reaches the receiver as `Authorization: {scheme} {credentials}`, held sealed, discarded on terminal', async () => {
    const { taskId, created } = await taskWithPush({ authentication: { scheme: SCHEME, credentials: SENTINEL } });

    // Held sealed: the stored record names the KMS envelope, never the value.
    const stored = await getA2aTask(taskId);
    expect(stored?.pushConfig?.sealedAuthorization?.startsWith('a2apush:kms:v1:')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(SENTINEL);
    // Not echoed by Create or GetTask.
    expect(JSON.stringify(created)).not.toContain(SENTINEL);
    expect(JSON.stringify(await send10('GetTask', { id: taskId }))).not.toContain(SENTINEL);

    await finishRun(taskId);
    expect(originHits).toHaveLength(1);
    expect(originHits[0]!.headers.authorization).toBe(`${SCHEME} ${SENTINEL}`);
    expect(originHits[0]!.headers['openwop-signature']).toBeUndefined();
    expect(outcomes).toEqual([{ delivered: true, status: 204 }]);

    // §A: discarded once the task is terminal and its final push was attempted.
    const after = await getA2aTask(taskId);
    expect(after?.pushConfig?.url).toBe(`${ORIGIN}/hook`);
    expect(after?.pushConfig?.sealedAuthorization).toBeUndefined();
  });

  it('0.3 `token` alone is sent as `Authorization: Bearer <token>`; `authentication.schemes[0]` wins when present', async () => {
    getAgentRegistry().register({
      agentId: 'peer.agent', persona: 'Peer', modelClass: 'general', systemPrompt: 'Respond.',
      packName: 'test', packVersion: '0', toolAllowlist: [],
      // Default confidence 0.9 < 0.99 ⇒ escalated ⇒ `input-required`: push-eligible
      // and NOT terminal, so the credential stays live across both pushes.
      confidence: { defaultThreshold: 0.99 },
    });
    const opts = { agentCard: { name: 'h', url: 'https://example.com/a2a', skills: [] }, durableTasks: true, tenantId: 't-03' } as const;
    const rpc = (method: string, params: Record<string, unknown>) => handleA2aRequest({ jsonrpc: '2.0', id: 1, method, params }, opts);
    const opened = await rpc('message/send', { agentId: 'peer.agent', message: { parts: [{ text: 'go' }] } });
    const id = (opened.result as { id?: string } | undefined)?.id ?? '';
    expect(id, 'fixture: message/send opened no task').not.toBe('');
    expect((await getA2aTask(id))?.state).toBe('input-required');
    const resend = () => rpc('message/send', { agentId: 'peer.agent', message: { parts: [{ text: 'again' }] }, id });

    const tokenOnly = await rpc('tasks/pushNotificationConfig/set', {
      id, pushNotificationConfig: { url: `${ORIGIN}/hook-token`, token: 'tok-abc' },
    });
    expect(tokenOnly.error).toBeUndefined();
    await resend();
    expect(originHits.map((h) => h.headers.authorization)).toEqual(['Bearer tok-abc']);

    const withAuth = await rpc('tasks/pushNotificationConfig/set', {
      id,
      pushNotificationConfig: { url: `${ORIGIN}/hook-auth`, token: 'tok-ignored', authentication: { schemes: [SCHEME, 'Basic'], credentials: SENTINEL } },
    });
    expect(withAuth.error).toBeUndefined();
    expect(JSON.stringify(withAuth)).not.toContain(SENTINEL);
    await resend();
    expect(originHits.map((h) => h.headers.authorization)).toEqual(['Bearer tok-abc', `${SCHEME} ${SENTINEL}`]);
  });

  it('refuses a credential that cannot be one header line, without echoing it', async () => {
    const sent = await send10('SendMessage', { message: { messageId: 'm-crlf', role: 'ROLE_USER', parts: [{ text: 'hi' }] } });
    const taskId = (sent.result as { task?: { id?: string } }).task!.id!;
    const bad = `${SENTINEL}\r\nX-Injected: 1`;
    const res = await send10('CreateTaskPushNotificationConfig', {
      taskId, url: `${ORIGIN}/hook`, authentication: { scheme: SCHEME, credentials: bad },
    });
    expect(res.error?.code).toBe(-32005);
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
    expect((await getA2aTask(taskId))?.pushConfig).toBeUndefined();
  });
});

describe('RFC 0214 §B — a 3xx is a failed delivery and is never followed', () => {
  it('a 307 is recorded failed, the redirect target receives nothing, and the credential is in no log or outcome', async () => {
    originStatus = 307;
    const { taskId } = await taskWithPush({ authentication: { scheme: SCHEME, credentials: SENTINEL } });
    await finishRun(taskId);

    // Positive control: the registered destination WAS dialed, with the credential.
    expect(originHits).toHaveLength(1);
    expect(originHits[0]!.headers.authorization).toBe(`${SCHEME} ${SENTINEL}`);
    // Never followed.
    expect(targetHits).toBe(0);
    expect(outcomes).toEqual([{ delivered: false, status: 307, reason: 'redirect' }]);

    // Recorded as failed, by task and reason, with no credential and no URL.
    const failed = logged.filter((l) => l.includes('a2a_push_delivery_failed'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('"reason":"redirect"');
    expect(failed[0]).toContain(taskId);
    expect(failed[0]).not.toContain(ORIGIN);
    expect(logged.join('')).not.toContain(SENTINEL);
    expect(JSON.stringify(outcomes)).not.toContain(SENTINEL);
  });
});
