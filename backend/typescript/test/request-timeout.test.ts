/**
 * API-4 — stream-safe request-timeout middleware. Verifies a stuck non-streaming
 * request is failed with the canonical envelope, that a streaming response (one
 * that has already flushed headers) is NEVER interrupted, and that a normal fast
 * response clears the timer.
 *
 * Sabotages that red this file (8fw1g4 round 1, 6 probes, all witnessed): dropping
 * the headersSent check (a stream gets a 503 written into it), not clearing on
 * `finish`, treating 0 as a real timeout, granting the LLM budget to non-POST
 * interrupt reads, a resolver that always grants the LLM budget, and the 503
 * status.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  requestTimeoutMiddleware,
  resolveTimeoutForRequest,
  isLlmBlockingRoute,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
} from '../src/middleware/requestTimeout.js';

interface FakeRes {
  headersSent: boolean;
  writableEnded: boolean;
  statusCode?: number;
  body?: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  on(event: string, cb: () => void): FakeRes;
  emit(event: string): void;
}

function makeRes(init: Partial<FakeRes> = {}): FakeRes {
  const handlers: Record<string, Array<() => void>> = {};
  const res: FakeRes = {
    headersSent: false,
    writableEnded: false,
    ...init,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    on(event, cb) { (handlers[event] ??= []).push(cb); return this; },
    emit(event) { (handlers[event] ?? []).forEach((cb) => cb()); },
  };
  return res;
}

// express's Request/Response cannot be constructed in a unit test; these two
// adapters are the ONE place a test double is narrowed to the express type. The
// middleware reads only `method`/`path` and `headersSent`/`writableEnded`/
// `status`/`json`/`on` — exactly what the doubles implement.
const asReq = (r: Pick<Request, 'method' | 'path'>): Request => r as Request;
const asRes = (r: FakeRes): Response => r as unknown as Response;
const ANY_REQ = asReq({ method: 'GET', path: '/x' });

describe('requestTimeoutMiddleware (API-4)', () => {
  afterEach(() => vi.useRealTimers());

  it('fails a stuck non-streaming request with the canonical envelope', () => {
    vi.useFakeTimers();
    const res = makeRes();
    const next = vi.fn();
    requestTimeoutMiddleware(1000)(ANY_REQ, asRes(res), next);
    expect(next).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'request_timeout', message: expect.stringContaining('1000ms') });
  });

  it('never interrupts a streaming response (headers already sent)', () => {
    vi.useFakeTimers();
    const res = makeRes({ headersSent: true });
    requestTimeoutMiddleware(1000)(ANY_REQ, asRes(res), vi.fn());
    vi.advanceTimersByTime(5000);
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toBeUndefined();
  });

  it('does not fire after the response finishes (timer cleared)', () => {
    vi.useFakeTimers();
    const res = makeRes();
    requestTimeoutMiddleware(1000)(ANY_REQ, asRes(res), vi.fn());
    res.emit('finish');
    vi.advanceTimersByTime(5000);
    expect(res.statusCode).toBeUndefined();
  });

  it('is disabled when timeout is 0', () => {
    vi.useFakeTimers();
    const res = makeRes();
    const next = vi.fn();
    requestTimeoutMiddleware(0)(ANY_REQ, asRes(res), next);
    expect(next).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(res.statusCode).toBeUndefined();
  });

  // The conversation `exchange` blocks on a reasoning-model LLM in-request, so
  // the interrupt-resolve routes need the longer budget; everything else keeps 30s.
  it('grants the LLM budget to the interrupt-resolve routes, the tight default elsewhere', () => {
    expect(isLlmBlockingRoute(asReq({ method: 'POST', path: '/runs/r1/interrupts/gate' }))).toBe(true);
    expect(isLlmBlockingRoute(asReq({ method: 'POST', path: '/interrupts/tok-123' }))).toBe(true);
    expect(isLlmBlockingRoute(asReq({ method: 'GET', path: '/runs/r1/interrupts/gate' }))).toBe(false);
    expect(isLlmBlockingRoute(asReq({ method: 'POST', path: '/runs' }))).toBe(false);

    expect(resolveTimeoutForRequest(asReq({ method: 'POST', path: '/runs/r1/interrupts/gate' }))).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutForRequest(asReq({ method: 'POST', path: '/runs' }))).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('uses the per-request resolver to time out a slow non-interrupt route at the default', () => {
    vi.useFakeTimers();
    const res = makeRes();
    // Default resolver: a /v1/runs POST gets the 30s budget, not the LLM 120s.
    requestTimeoutMiddleware()(asReq({ method: 'POST', path: '/runs' }), asRes(res), vi.fn());
    vi.advanceTimersByTime(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(res.statusCode).toBe(503);
  });
});
