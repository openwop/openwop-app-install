/**
 * Suspend manager singleton. Backs interrupt persistence onto the
 * storage adapter so a process restart between node-suspend and
 * resume doesn't drop the awaiting state.
 *
 * As of P3.3 every method is async — Storage is async-native.
 */

import { randomBytes } from 'node:crypto';
import type { InterruptRecord } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { emitInterruptNotification } from '../notifications/notify.js';

let backend: Storage | null = null;

export function setSuspendBackend(storage: Storage): void {
  backend = storage;
}

/** Default signed-token lifetime (RFC 0093 §B.1): 30 minutes, overridable
 *  via OPENWOP_INTERRUPT_TOKEN_TTL_SEC. Read per-mint so tests can flip it. */
function tokenTtlMs(): number {
  const raw = process.env.OPENWOP_INTERRUPT_TOKEN_TTL_SEC;
  const parsed = raw ? Number(raw) : NaN;
  const ttlSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60;
  return ttlSec * 1_000;
}

/** Token expiry per RFC 0093 §B.1: now + TTL, capped at the interrupt's own
 *  deadline (`timeoutMs`, carried in the suspend payload's data) when one
 *  exists — a token MUST NOT outlive the interrupt it resolves. */
function mintExpiresAt(nowMs: number, data: unknown): string {
  let expiresMs = nowMs + tokenTtlMs();
  const timeoutMs = (data as { timeoutMs?: unknown } | null)?.timeoutMs;
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    expiresMs = Math.min(expiresMs, nowMs + timeoutMs);
  }
  return new Date(expiresMs).toISOString();
}

export function getSuspendManager() {
  if (!backend) throw new Error('SuspendManager backend not installed');
  const b = backend;
  return {
    async createInterrupt(input: {
      runId: string;
      nodeId: string;
      kind: InterruptRecord['kind'];
      data: unknown;
      resumeSchema?: Record<string, unknown>;
    }): Promise<InterruptRecord> {
      const interruptId = randomBytes(16).toString('hex');
      // Opaque high-entropy token (256-bit random, base64url). The random
      // value IS the credential — there's nothing to forge, so DB lookup +
      // possession satisfies the RFC 0093 §B.3 verification intent (the
      // routes layer still re-compares with timingSafeEqual).
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      const data = stripSecretsFromPersisted(input.data);
      const record: InterruptRecord = {
        interruptId,
        runId: input.runId,
        nodeId: input.nodeId,
        kind: input.kind,
        token,
        data,
        resumeSchema: input.resumeSchema,
        createdAt: new Date(now).toISOString(),
        // RFC 0093 §B.1 — every signed token carries an expiry.
        expiresAt: mintExpiresAt(now, data),
      };
      await b.insertInterrupt(record);
      // Fan out a notification so the bell + /inbox surface the
      // action-needed signal without polling. Best-effort — emit
      // failures don't abort the suspend (the interrupt row is
      // already persisted and the run will still resume via the
      // normal /v1/interrupts surface).
      void emitInterruptNotification(b, record);
      return record;
    },
    async resolve(interruptId: string, value: unknown): Promise<void> {
      await b.resolveInterrupt(interruptId, value, new Date().toISOString());
    },
    async getByToken(token: string): Promise<InterruptRecord | null> {
      return await b.getInterruptByToken(token);
    },
    async getByNode(runId: string, nodeId: string): Promise<InterruptRecord | null> {
      return await b.getInterruptByNode(runId, nodeId);
    },
    async listOpen(runId: string): Promise<readonly InterruptRecord[]> {
      return await b.listOpenInterrupts(runId);
    },
  };
}
