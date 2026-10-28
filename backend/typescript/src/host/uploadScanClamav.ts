/**
 * ADR 0958 Q2 (decided 2026-10-26: a SELF-HOSTED ClamAV, no vendor account) — the
 * scanner behind the upload scan port (`uploadScan.ts`).
 *
 * It speaks clamd's own `INSTREAM` protocol over TCP with `node:net`, so there is no
 * new dependency and no third party in the path:
 *   send `zINSTREAM\0`, then chunks of `[uint32 big-endian length][bytes]`, then a
 *   zero-length chunk; clamd answers `stream: OK`, `stream: <signature> FOUND`, or
 *   `... ERROR` (each NUL-terminated with the `z` prefix).
 *
 * Configuration (read at boot; nothing set ⇒ no scanner, the port stays
 * `not_configured` and the intake type allowlist is the only guard):
 *   OPENWOP_CLAMAV_HOST        the clamd host. `127.0.0.1` for a Cloud Run sidecar.
 *   OPENWOP_CLAMAV_PORT        default 3310.
 *   OPENWOP_CLAMAV_TIMEOUT_MS  whole-scan deadline, default 20000.
 *
 * clamd has no authentication: it must only be reachable from this backend (a
 * sidecar on localhost, or a private network). Every failure (refused, timeout,
 * `ERROR`, a reply this code does not recognise, size over clamd's
 * StreamMaxLength) throws, which the port turns into `error`: fail closed. Only an
 * explicit `OK` is clean, and only an explicit `FOUND` is infected.
 */
import { connect } from 'node:net';
import { registerUploadScanner, type UploadScanner } from './uploadScan.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.uploadScan.clamav');
const CHUNK = 64 * 1024;

export interface ClamavOptions { host: string; port: number; timeoutMs: number }

export function clamavOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ClamavOptions | null {
  const host = (env.OPENWOP_CLAMAV_HOST ?? '').trim();
  if (!host) return null;
  const port = Number(env.OPENWOP_CLAMAV_PORT ?? 3310);
  const timeoutMs = Number(env.OPENWOP_CLAMAV_TIMEOUT_MS ?? 20000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`OPENWOP_CLAMAV_PORT must be a TCP port, got "${env.OPENWOP_CLAMAV_PORT}"`);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100) throw new Error(`OPENWOP_CLAMAV_TIMEOUT_MS must be at least 100, got "${env.OPENWOP_CLAMAV_TIMEOUT_MS}"`);
  return { host, port, timeoutMs };
}

/** Parse clamd's INSTREAM reply. Anything not exactly OK or FOUND is a failure. */
export function parseClamdReply(raw: string): 'clean' | 'infected' {
  const reply = raw.replace(/\0/g, '').trim();
  if (/^stream: OK$/.test(reply)) return 'clean';
  if (/^stream: .+ FOUND$/.test(reply)) return 'infected';
  throw new Error(`clamd: ${reply ? reply.slice(0, 200) : 'empty reply'}`);
}

export function clamavScanner(opts: ClamavOptions): UploadScanner {
  return {
    scan: ({ bytes }) => new Promise<'clean' | 'infected'>((resolve, reject) => {
      let settled = false;
      let reply = '';
      const done = (err: Error | null, v?: 'clean' | 'infected'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err); else resolve(v!);
      };
      const socket = connect({ host: opts.host, port: opts.port });
      const timer = setTimeout(() => done(new Error(`clamd: no verdict within ${opts.timeoutMs} ms`)), opts.timeoutMs);
      socket.on('error', (err) => done(new Error(`clamd: ${err.message}`)));
      socket.on('data', (d) => { reply += d.toString('utf8'); if (reply.includes('\0')) { try { done(null, parseClamdReply(reply)); } catch (e) { done(e as Error); } } });
      socket.on('end', () => { try { done(null, parseClamdReply(reply)); } catch (e) { done(e as Error); } });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let off = 0; off < bytes.length; off += CHUNK) {
          const part = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length, 0);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk: end of stream
      });
    }),
  };
}

/** Boot: register the ClamAV scanner when configured. Returns whether it did. */
export function registerClamavScannerFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const opts = clamavOptionsFromEnv(env);
  if (!opts) return false;
  registerUploadScanner(clamavScanner(opts));
  log.info('upload_scanner_registered', { kind: 'clamav', host: opts.host, port: opts.port, timeoutMs: opts.timeoutMs });
  return true;
}
