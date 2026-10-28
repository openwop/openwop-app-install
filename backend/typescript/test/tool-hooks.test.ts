/**
 * RFC 0064 — tool-invocation hooks + per-tool authorization/rate-limit.
 *
 * Unit-tests the host evaluator that backs both the live MCP path and the
 * `POST /host/openwop-app/toolhooks/invoke` conformance seam:
 *   - ok path: status 'ok', argsHash is a 64-char hex digest
 *   - authorization fail-closed: missing/short scopes → 'forbidden' (403)
 *   - rate limit: bucket exhaustion / simulate flag → 'rate_limited' (429)
 *   - SR-1: a secret-shaped arg never survives into the hash preimage
 *
 * @see RFCS/0064-tool-invocation-hooks-and-authorization.md
 *
 * Protected (authz fail-closed, rate limit, SR-1). Wave 61:
 *   - the forbidden fixture holds ONE of TWO required scopes, so `every` and
 *     `some` give different answers (probe th-every);
 *   - the bucket case proves the key is per-(principal, tool) and that the
 *     window resets at exactly 60 000 ms, on a pinned literal clock;
 *   - SR-1 case 1 hashes through the product's `computeArgsHash` and compares
 *     with a sha256 computed here over a hand-written preimage, instead of
 *     re-running the scrub + canonicalize pipeline itself (probe
 *     th-sr1-preimage only reddened case 2 before).
 *   - HONEST DOUBLE GUARD (probe th-undefined, vacuous by design): in
 *     "scopes unevaluable", `grantedScopes !== undefined` is redundant with
 *     `required.every(granted.has)` over the EMPTY Set `new Set(undefined ?? [])`
 *     — either alone refuses. The shared piece both feed, `if (!holdsAll)`, is
 *     probed by th-gate.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  evaluateToolHook,
  computeArgsHash,
  resetToolHookBuckets,
  extractToolErrorCode,
  deriveToolErrorCode,
} from '../src/host/toolHooks.js';
import { createHash } from 'node:crypto';

beforeEach(() => {
  resetToolHookBuckets();
});

describe('RFC 0064 — evaluateToolHook', () => {
  it('ok: authorized + within budget runs the tool and hashes args', () => {
    const r = evaluateToolHook({
      principal: 'user:alice',
      toolName: 'search',
      requiredScopes: ['tools.search'],
      grantedScopes: ['tools.search', 'tools.read'],
      args: { q: 'hello' },
      transport: 'mcp',
    });
    expect(r.httpStatus).toBe(200);
    expect(r.toolReturned.status).toBe('ok');
    expect(r.toolReturned.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.toolCalled.transport).toBe('mcp');
    expect(r.toolCalled.principal).toBe('user:alice');
    expect(r.toolCalled.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.errorCode).toBeUndefined();
  });

  it('forbidden (fail-closed): principal lacks a required scope', () => {
    const r = evaluateToolHook({
      principal: 'user:bob',
      toolName: 'delete',
      // Holds one of the two required scopes: ALL are required, not any.
      requiredScopes: ['tools.delete', 'tools.read'],
      grantedScopes: ['tools.read'],
      args: {},
    });
    expect(r.httpStatus).toBe(403);
    expect(r.toolReturned.status).toBe('forbidden');
    expect(r.toolReturned.durationMs).toBeUndefined();
    expect(r.errorCode).toBe('forbidden');
  });

  it('forbidden (fail-closed): scopes unevaluable (grantedScopes absent)', () => {
    const r = evaluateToolHook({
      principal: 'user:bob',
      toolName: 'delete',
      requiredScopes: ['tools.delete'],
      args: {},
    });
    expect(r.httpStatus).toBe(403);
    expect(r.toolReturned.status).toBe('forbidden');
  });

  it('rate_limited: simulate flag forces the rate-limit branch', () => {
    const r = evaluateToolHook({
      principal: 'user:alice',
      toolName: 'search',
      args: {},
      simulateRateLimitExhausted: true,
    });
    expect(r.httpStatus).toBe(429);
    expect(r.toolReturned.status).toBe('rate_limited');
    expect(r.toolReturned.durationMs).toBeUndefined();
    expect(r.errorCode).toBe('rate_limited');
  });

  it('rate_limited: per-(principal,tool) bucket exhausts after capacity', () => {
    const call = () =>
      evaluateToolHook({ principal: 'p', toolName: 't', args: {} }).toolReturned.status;
    // Capacity is 5; the 6th call within the window is rate-limited.
    const statuses = Array.from({ length: 6 }, call);
    expect(statuses.slice(0, 5)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(statuses[5]).toBe('rate_limited');
    // The bucket is keyed on the PAIR: the same principal on another tool, and
    // another principal on the same tool, each still have their own budget.
    expect(evaluateToolHook({ principal: 'p', toolName: 't2', args: {} }).toolReturned.status).toBe('ok');
    expect(evaluateToolHook({ principal: 'p2', toolName: 't', args: {} }).toolReturned.status).toBe('ok');
    // The window: on a pinned clock, still limited 1 ms before 60 s, refilled at 60 s.
    const T0 = 1_700_000_000_000;
    const at = (now: number): string =>
      evaluateToolHook({ principal: 'pw', toolName: 'tw', args: {} }, now).toolReturned.status;
    expect([T0, T0, T0, T0, T0].map(at)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(at(T0 + 59_999)).toBe('rate_limited');
    expect(at(T0 + 60_000)).toBe('ok');
  });

  it('§F error: a ran-and-threw failure carries status:error + populated error + durationMs (it ran)', () => {
    const r = evaluateToolHook({
      principal: 'user:alice',
      toolName: 'search',
      // The tool passes the gates (no requiredScopes) and runs, then throws.
      args: { q: 'hello' },
      simulateToolError: true,
    });
    // The seam call itself succeeds — the failure lives in the tool event.
    expect(r.httpStatus).toBe(200);
    expect(r.toolReturned.status).toBe('error');
    expect(r.toolReturned.error).toEqual({ code: 'tool_execution_failed', message: 'simulated tool execution failure' });
    // It RAN → non-negative duration (unlike the forbidden/rate_limited gates).
    expect(r.toolReturned.durationMs).toBeGreaterThanOrEqual(0);
    // A ran-and-threw error is not an HTTP-level errorCode (that's for the gates).
    expect(r.errorCode).toBeUndefined();
  });

  it('§F error: the gate statuses still carry NO error payload (error ⊥ gate)', () => {
    const forbidden = evaluateToolHook({ principal: 'p', toolName: 't', requiredScopes: ['s'], args: {} });
    expect(forbidden.toolReturned.status).toBe('forbidden');
    expect(forbidden.toolReturned.error).toBeUndefined();
    const limited = evaluateToolHook({ principal: 'p', toolName: 't', args: {}, simulateRateLimitExhausted: true });
    expect(limited.toolReturned.status).toBe('rate_limited');
    expect(limited.toolReturned.error).toBeUndefined();
  });
});

describe('RFC 0064 §F — tool-error code classifiers', () => {
  it('extractToolErrorCode: a thrown structured code wins; an unstructured throw is generic', () => {
    expect(extractToolErrorCode(Object.assign(new Error('off'), { code: 'host_capability_disabled' }))).toBe('host_capability_disabled');
    expect(extractToolErrorCode(new Error('boom'))).toBe('tool_execution_failed');
    expect(extractToolErrorCode('a bare string')).toBe('tool_execution_failed');
    expect(extractToolErrorCode(null)).toBe('tool_execution_failed');
  });

  it('deriveToolErrorCode: prefers errorCode (a swallowed throw), else parses content JSON (.code/.error), else generic', () => {
    // 1. explicit errorCode wins even over a content code (the throw is authoritative).
    expect(deriveToolErrorCode({ content: '{"code":"other"}', errorCode: 'host_capability_disabled' })).toBe('host_capability_disabled');
    // 2. returned structured failure — code parsed from the stringified content.
    expect(deriveToolErrorCode({ content: JSON.stringify({ code: 'host_capability_missing', message: 'no surface' }) })).toBe('host_capability_missing');
    expect(deriveToolErrorCode({ content: JSON.stringify({ error: 'validation_error', message: 'bad' }) })).toBe('validation_error');
    // 3. non-JSON content (a plain `tool_failed: …` string) → generic.
    expect(deriveToolErrorCode({ content: 'tool_failed: kaboom' })).toBe('tool_execution_failed');
    expect(deriveToolErrorCode({ content: '' })).toBe('tool_execution_failed');
    // a JSON scalar / array with no code → generic (never throws).
    expect(deriveToolErrorCode({ content: '"just a string"' })).toBe('tool_execution_failed');
    expect(deriveToolErrorCode({ content: '[1,2,3]' })).toBe('tool_execution_failed');
  });
});

describe('RFC 0064 — SR-1 content-free argsHash', () => {
  it('redacts a secret-shaped arg before hashing (preimage carries no secret)', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
    const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
    // The hash is over the hand-written REDACTED preimage, and not over the raw one.
    const got = computeArgsHash({ apiKey: secret });
    expect(got).toBe(sha256('{"apiKey":"sk-***"}'));
    expect(got).not.toBe(sha256(`{"apiKey":"${secret}"}`));
  });

  it('argsHash with a secret equals argsHash with the redacted placeholder', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
    const withSecret = computeArgsHash({ apiKey: secret });
    const withPlaceholder = computeArgsHash({ apiKey: 'sk-***' });
    expect(withSecret).toBe(withPlaceholder);
  });
});
