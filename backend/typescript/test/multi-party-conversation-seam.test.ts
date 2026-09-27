/**
 * RFC 0101 multi-party conversation — the host-sample seam's four MUSTs.
 *
 * The host advertises `multiPartyConversation.supported: true`. Under RFC 0148
 * §B that advert obliges the behaviour to be OBSERVABLE, and the suite's
 * host-agnostic way to observe it is the seam
 * (`spec/v1/host-sample-test-seams.md`). Before this, the advert was true and
 * the seam was absent, so the behavioural leg soft-skipped — a claim with no
 * witness.
 *
 * These assert the same four things the conformance leg does, host-side, so a
 * regression is caught by `npm run ci` and not only by a conformance run:
 *   1. a roster-valid attributed agent turn is ACCEPTED;
 *   2. a `role:'agent'` turn with no `speakerId` is `validation_error`;
 *   3. a turn whose `speakerId` is outside the roster is `validation_error`;
 *   4. a roster exceeding `maxParticipants` is `validation_error` on open.
 * Plus the two the contract specifies around them: an unknown conversationId is
 * `not_found`, and the advertised cap is a ceiling the request cannot widen.
 *
 * RFC 0005 §E pins the error CODE, not the status, so these assert on
 * `error.code` exactly as the suite does.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { MAX_MULTI_PARTY_PARTICIPANTS } from '../src/host/multiPartyConversation.js';
import { __resetMultiPartyCouncils } from '../src/routes/multiPartyConversationSeam.js';

const CONV = 'conf:multi-party:council-q1';
const ROSTER = [{ agentId: 'host:advisor-cfo' }, { agentId: 'host:advisor-cmo' }, { agentId: 'host:advisor-coo' }];

interface ErrBody {
  error?: string | { code?: string };
  accepted?: boolean;
  conversationId?: string;
}

/** The host renders errors as `{ error: 'code', ... }` on some paths and
 *  `{ error: { code } }` on others; the suite tolerates both, so normalize. */
function errCode(body: ErrBody): string | undefined {
  if (typeof body.error === 'string') return body.error;
  return body.error?.code;
}

describe('RFC 0101 multi-party conversation seam', () => {
  let server: http.Server;
  let BASE: string;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => {
        BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        res();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  beforeEach(() => {
    __resetMultiPartyCouncils();
  });

  async function post<T = ErrBody>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  const open = (participants: { agentId: string }[], maxParticipants?: number) =>
    post('/v1/host/sample/conversation/multi-party/open', {
      conversationId: CONV,
      participants,
      ...(maxParticipants === undefined ? {} : { maxParticipants }),
    });

  const exchange = (turn: Record<string, unknown>, conversationId = CONV) =>
    post('/v1/host/sample/conversation/multi-party/exchange', { conversationId, turn });

  // The `sample` spelling is rewritten onto `openwop-app` when the test seam is
  // ENABLED (routes/testSeam.ts), which is the conformance boot's posture and
  // not this test's. So driving only one spelling proves only one, and the two
  // diverge precisely under the boot that matters: registering `sample` alone
  // passed here and 404'd the conformance leg. Both are asserted.
  it('serves BOTH the sample and openwop-app spellings of the seam', async () => {
    for (const prefix of ['/v1/host/sample', '/v1/host/openwop-app']) {
      const opened = await post(`${prefix}/conversation/multi-party/open`, {
        conversationId: `${CONV}:${prefix}`,
        participants: ROSTER,
      });
      expect(opened.status, `${prefix} open`).toBe(200);
      expect(opened.body.accepted, `${prefix} open`).toBe(true);

      const turned = await post(`${prefix}/conversation/multi-party/exchange`, {
        conversationId: `${CONV}:${prefix}`,
        turn: { role: 'agent', speakerId: 'host:advisor-cfo', content: 'ok', turnIndex: 1 },
      });
      expect(turned.status, `${prefix} exchange`).toBe(200);
      expect(turned.body.accepted, `${prefix} exchange`).toBe(true);
    }
  });

  it('advertises the capability the seam witnesses', async () => {
    const res = await fetch(`${BASE}/.well-known/openwop`, { headers: { authorization: 'Bearer dev-token' } });
    const body = (await res.json()) as { multiPartyConversation?: { supported?: boolean; maxParticipants?: number } };
    expect(body.multiPartyConversation?.supported).toBe(true);
    expect(body.multiPartyConversation?.maxParticipants).toBe(MAX_MULTI_PARTY_PARTICIPANTS);
  });

  it('opens a council and ACCEPTS a roster-valid attributed agent turn', async () => {
    const opened = await open(ROSTER);
    expect(opened.status).toBe(200);
    expect(opened.body.accepted).toBe(true);

    const ok = await exchange({ role: 'agent', speakerId: 'host:advisor-cfo', content: 'Margins hold.', turnIndex: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.accepted).toBe(true);
  });

  it("rejects a role:'agent' turn with no speakerId (attribution MUST)", async () => {
    await open(ROSTER);
    const res = await exchange({ role: 'agent', content: 'Who said this?', turnIndex: 1 });
    expect(errCode(res.body)).toBe('validation_error');
  });

  it('rejects a speaker outside the declared roster (membership MUST, fail-closed)', async () => {
    await open(ROSTER);
    const res = await exchange({ role: 'agent', speakerId: 'host:advisor-uninvited', content: 'Barging in.', turnIndex: 1 });
    expect(errCode(res.body)).toBe('validation_error');
  });

  it('rejects a roster over maxParticipants, and the request cannot widen the advertised cap', async () => {
    const tooMany = Array.from({ length: MAX_MULTI_PARTY_PARTICIPANTS + 1 }, (_, i) => ({ agentId: `host:advisor-${i}` }));

    // Over the host's advertised cap.
    expect(errCode((await open(tooMany)).body)).toBe('validation_error');

    // Still rejected when the CALLER asks for a bigger cap — the advertised
    // maximum is a ceiling, not a default. A host that honoured the request
    // here would be seating more agents than it advertises it can.
    expect(errCode((await open(tooMany, 999)).body)).toBe('validation_error');

    // And a request that NARROWS the cap is honoured.
    expect(errCode((await open(ROSTER, 2)).body)).toBe('validation_error');
  });

  it('404s an exchange against a conversation that was never opened', async () => {
    const res = await exchange({ role: 'agent', speakerId: 'host:advisor-cfo', content: 'hi', turnIndex: 1 }, 'conf:never-opened');
    expect(res.status).toBe(404);
    expect(errCode(res.body)).toBe('not_found');
  });

  it('leaves a non-agent turn unattributed-but-accepted (the rule is agent-scoped)', async () => {
    await open(ROSTER);
    const res = await exchange({ role: 'user', content: 'What is the margin outlook?', turnIndex: 0 });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
  });
});
