/**
 * ADR 0958 Q2 — the self-hosted ClamAV scanner behind the upload scan port, against
 * a fake clamd that speaks the real INSTREAM framing over TCP.
 *
 * Legs:
 *  1. Framing: the bytes clamd reassembles from the length-prefixed chunks are the
 *     upload's bytes exactly (a payload over one 64 KiB chunk), ending in a zero chunk.
 *  2. Verdicts through the port (`scanUpload`): `OK` → clean; `<sig> FOUND` → infected
 *     (the EICAR test string); an `ERROR` reply, an unrecognised reply, a closed
 *     connection with no reply, no listener, and no verdict in time → `error`
 *     (fail closed: a scan that did not happen is never a pass).
 *  3. Boot: no OPENWOP_CLAMAV_HOST ⇒ no scanner (`not_configured`); set ⇒ registered;
 *     a malformed port or timeout throws rather than silently running unscanned.
 *
 * Sabotage-witnessed: treating an unrecognised reply as clean, treating `end` with
 * no reply as clean, dropping the timeout, and omitting the terminating zero chunk
 * each turn a leg red.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clamavScanner, clamavOptionsFromEnv, parseClamdReply, registerClamavScannerFromEnv } from '../src/host/uploadScanClamav.js';
import { registerUploadScanner, scanUpload, isUploadScannerConfigured } from '../src/host/uploadScan.js';

// The standard antivirus test string (harmless by design; every engine flags it).
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

type Mode = 'scan' | 'error' | 'garbage' | 'close' | 'hang';
let mode: Mode = 'scan';
let received: Buffer[] = [];
let sawTerminator = false;
let server: Server;
let port = 0;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    let header = false;
    const chunks: Buffer[] = [];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!header) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        if (buf.subarray(0, nul).toString() !== 'zINSTREAM') { sock.end('UNKNOWN COMMAND\0'); return; }
        buf = buf.subarray(nul + 1); header = true;
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          sawTerminator = true;
          received = chunks;
          const body = Buffer.concat(chunks).toString('latin1');
          if (mode === 'hang') return;
          if (mode === 'close') { sock.end(); return; }
          if (mode === 'error') { sock.end('stream: INSTREAM size limit exceeded. ERROR\0'); return; }
          if (mode === 'garbage') { sock.end('PONG\0'); return; }
          sock.end(body.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + len) return;
        chunks.push(Buffer.from(buf.subarray(4, 4 + len)));
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => { mode = 'scan'; received = []; sawTerminator = false; registerUploadScanner(null); });
afterAll(async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); });

const scanWith = (opts: { host?: string; port?: number; timeoutMs?: number }, bytes: Buffer) => {
  registerUploadScanner(clamavScanner({ host: opts.host ?? '127.0.0.1', port: opts.port ?? port, timeoutMs: opts.timeoutMs ?? 2000 }));
  return scanUpload({ tenantId: 't', contentType: 'application/pdf', bytes });
};

describe('ADR 0958 Q2 — ClamAV over INSTREAM', () => {
  it('frames the upload exactly: length-prefixed chunks, then a zero chunk', async () => {
    const payload = Buffer.alloc(150 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    expect(await scanWith({}, payload)).toBe('clean');
    expect(sawTerminator).toBe(true);
    expect(received.length).toBeGreaterThan(1);
    expect(Buffer.concat(received).equals(payload)).toBe(true);
  });

  it('OK is clean; FOUND is infected', async () => {
    expect(await scanWith({}, Buffer.from('%PDF-1.7 harmless'))).toBe('clean');
    expect(await scanWith({}, Buffer.from(EICAR))).toBe('infected');
  });

  it('fails closed: ERROR, an unknown reply, a silent close, no listener, no verdict in time', async () => {
    mode = 'error';
    expect(await scanWith({}, Buffer.from('x'))).toBe('error');
    mode = 'garbage';
    expect(await scanWith({}, Buffer.from('x'))).toBe('error');
    mode = 'close';
    expect(await scanWith({}, Buffer.from('x'))).toBe('error');
    mode = 'scan';
    // A port nothing listens on: bind one, then close it.
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    expect(await scanWith({ port: deadPort }, Buffer.from('x'))).toBe('error');
    mode = 'hang';
    const t0 = Date.now();
    expect(await scanWith({ timeoutMs: 300 }, Buffer.from('x'))).toBe('error');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('parses only exact verdicts', () => {
    expect(parseClamdReply('stream: OK\0')).toBe('clean');
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toBe('infected');
    expect(() => parseClamdReply('stream: OK but not really')).toThrow();
    expect(() => parseClamdReply('')).toThrow();
  });
});

describe('ADR 0958 Q2 — boot configuration', () => {
  it('nothing set: no scanner; set: registered; malformed: throws', async () => {
    expect(registerClamavScannerFromEnv({})).toBe(false);
    expect(isUploadScannerConfigured()).toBe(false);
    expect(await scanUpload({ tenantId: 't', contentType: 'image/png', bytes: Buffer.from('x') })).toBe('not_configured');

    expect(registerClamavScannerFromEnv({ OPENWOP_CLAMAV_HOST: '127.0.0.1', OPENWOP_CLAMAV_PORT: String(port) })).toBe(true);
    expect(isUploadScannerConfigured()).toBe(true);
    expect(await scanUpload({ tenantId: 't', contentType: 'application/pdf', bytes: Buffer.from(EICAR) })).toBe('infected');

    expect(clamavOptionsFromEnv({ OPENWOP_CLAMAV_HOST: 'clamd' })).toEqual({ host: 'clamd', port: 3310, timeoutMs: 20000 });
    expect(() => clamavOptionsFromEnv({ OPENWOP_CLAMAV_HOST: 'clamd', OPENWOP_CLAMAV_PORT: 'abc' })).toThrow(/PORT/);
    expect(() => clamavOptionsFromEnv({ OPENWOP_CLAMAV_HOST: 'clamd', OPENWOP_CLAMAV_TIMEOUT_MS: '5' })).toThrow(/TIMEOUT/);
  });
});
