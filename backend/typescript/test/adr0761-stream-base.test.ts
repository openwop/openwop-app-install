/**
 * ADR 0761 — `extensions["openwop-app.host"].streamBase`: advertised only when
 * OPENWOP_STREAM_BASE_URL is a clean https origin, never otherwise.
 *
 * Red when (wave 60 probes, tracker TST-BRA-7): the `https:` check admits `http:`;
 * the credentials, query or fragment refusal is dropped; an unparseable value is
 * accepted; the trailing slash is kept; or discovery stops spreading
 * `streamBaseRecord()` into `extensions["openwop-app.host"]`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { resetStreamBaseWarningForTests, streamBaseUrl } from '../src/host/streamBase.js';

describe('streamBaseUrl — validation', () => {
  afterEach(() => resetStreamBaseWarningForTests());
  it('accepts an https origin (with an optional path prefix) and strips the trailing slash', () => {
    expect(streamBaseUrl({ OPENWOP_STREAM_BASE_URL: 'https://svc-123.us-central1.run.app/' })).toBe('https://svc-123.us-central1.run.app');
    expect(streamBaseUrl({ OPENWOP_STREAM_BASE_URL: 'https://h.example/api' })).toBe('https://h.example/api');
  });
  it('advertises nothing when unset or blank', () => {
    expect(streamBaseUrl({})).toBeUndefined();
    expect(streamBaseUrl({ OPENWOP_STREAM_BASE_URL: '  ' })).toBeUndefined();
  });
  it.each([
    ['http://svc.run.app', 'a scheme downgrade'],
    ['https://user:pw@svc.run.app', 'credentials'],
    ['https://svc.run.app/?x=1', 'a query'],
    ['https://svc.run.app/#f', 'a fragment'],
    ['not a url', 'garbage'],
  ])('refuses %s (%s)', (value) => {
    expect(streamBaseUrl({ OPENWOP_STREAM_BASE_URL: value })).toBeUndefined();
  });
});

describe('discovery advertises streamBase only when configured', () => {
  let server: http.Server; let base = '';
  const prior = process.env.OPENWOP_STREAM_BASE_URL;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (prior === undefined) delete process.env.OPENWOP_STREAM_BASE_URL; else process.env.OPENWOP_STREAM_BASE_URL = prior;
    await new Promise<void>((r) => server.close(() => r()));
  });
  const hostRecord = async (): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
    expect(res.status).toBe(200);
    const doc = await res.json() as { extensions: Record<string, Record<string, unknown>> };
    return doc.extensions['openwop-app.host'] ?? {};
  };

  it('absent when unset', async () => {
    delete process.env.OPENWOP_STREAM_BASE_URL;
    expect(await hostRecord()).not.toHaveProperty('streamBase');
  });
  it('present (normalised) when a valid https origin is configured', async () => {
    process.env.OPENWOP_STREAM_BASE_URL = 'https://svc-1.us-central1.run.app/';
    expect((await hostRecord()).streamBase).toBe('https://svc-1.us-central1.run.app');
  });
  it('absent when the configured value is a downgrade', async () => {
    process.env.OPENWOP_STREAM_BASE_URL = 'http://svc-1.us-central1.run.app';
    expect(await hostRecord()).not.toHaveProperty('streamBase');
  });
});
