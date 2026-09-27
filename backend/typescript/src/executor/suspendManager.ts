/**
 * Suspend manager singleton. Backs interrupt persistence onto the
 * storage adapter so a process restart between node-suspend and
 * resume doesn't drop the awaiting state.
 *
 * As of P3.3 every method is async — Storage is async-native.
 */

import { randomBytes } from 'node:crypto';
import type { InterruptRecord } from '../types.js';
import { mintInterruptToken } from '../host/interruptToken.js';
import type { Storage } from '../storage/storage.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { emitInterruptNotification } from '../notifications/notify.js';
import { recordInterruptCreated } from '../observability/metricSeams.js';

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
function mintExpiresAt(nowMs: number, data: unknown, createdMs: number = nowMs): string {
  let expiresMs = nowMs + tokenTtlMs();
  const timeoutMs = (data as { timeoutMs?: unknown } | null)?.timeoutMs;
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    // The deadline runs from the gate's creation — for a fork-inherited gate
    // that is the SOURCE's creation (ADR 0751), so a fork never extends it.
    expiresMs = Math.min(expiresMs, createdMs + timeoutMs);
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
      /** ADR 0751 — a gate a FORK re-creates keeps the source gate's `createdAt`:
       *  the approval-timeout and timer deadlines derive from it, and ADR 0262
       *  ruling #2 makes a fork inherit the original deadline. The token is still
       *  fresh; its expiry is capped at that inherited deadline. */
      createdAt?: string;
    }): Promise<InterruptRecord> {
      const interruptId = randomBytes(16).toString('hex');
      // `spec/v2/core/identity.md` §4 (RFC 0170 §E.1) — `ow2.<alg>.<kid>.
      // <payload>.<mac>`. The `payload` is the same 256-bit random credential
      // this host has always minted (the random value IS the credential —
      // there is nothing to forge, and DB lookup + possession satisfies the
      // RFC 0093 §B.3 verification intent); the prefix, `alg` and `kid` are
      // what §4 adds, so a verification secret can rotate without orphaning
      // outstanding tokens. The FULL string is what is stored and presented, so
      // the row lookup and the `timingSafeEqual` re-compare in the routes layer
      // are unchanged, and tokens minted before this change keep resolving
      // under the `legacy` disposition (`host/interruptToken.ts`).
      const token = mintInterruptToken();
      const now = Date.now();
      const inherited = input.createdAt !== undefined ? Date.parse(input.createdAt) : NaN;
      const createdMs = Number.isFinite(inherited) ? inherited : now;
      const data = stripSecretsFromPersisted(input.data);
      const record: InterruptRecord = {
        interruptId,
        runId: input.runId,
        nodeId: input.nodeId,
        kind: input.kind,
        token,
        data,
        resumeSchema: input.resumeSchema,
        createdAt: new Date(createdMs).toISOString(),
        // RFC 0093 §B.1 — every signed token carries an expiry.
        expiresAt: mintExpiresAt(now, data, createdMs),
      };
      await b.insertInterrupt(record);
      // ADR 0556 P1 — the denominator for the age histogram below. Emitted
      // AFTER the row is durable: an interrupt that failed to persist never
      // existed, and counting it would make "created minus resolved" report a
      // permanent backlog that nobody can clear.
      recordInterruptCreated(record.kind);
      // Fan out a notification so the bell + /inbox surface the
      // action-needed signal without polling. Best-effort — emit
      // failures don't abort the suspend (the interrupt row is
      // already persisted and the run will still resume via the
      // normal /v1/interrupts surface). A `timer` interrupt (ADR 0267)
      // needs NO human action — it self-resolves on its deadline — so it
      // is deliberately silent (never a bell for a scheduled wait).
      // tour-step: the player resolves within milliseconds (or the user is
      // ALREADY looking at the spotlighted step) — a notification is noise.
      if (record.kind !== 'timer' && record.kind !== 'tour-step' && record.kind !== 'walkthrough-step') void emitInterruptNotification(b, record);
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
