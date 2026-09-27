/**
 * ADR 0553 P2 — the MRTR `requestState` (RFC 0153 §C.2).
 *
 * Upstream classes `requestState` as ATTACKER-CONTROLLED on receipt: the server
 * mints it, the client echoes it back, and nothing about the round trip stops a
 * peer from echoing something else. `mcp-integration.md` §C.2 therefore turns
 * upstream's SHOULD into a MUST and adds two bindings of its own:
 *
 *   > **Opaque, integrity-protected, bound.** … the host **MUST** HMAC/sign it
 *   > and **MUST** bind the authenticated principal, a TTL, and the originating
 *   > request digest inside it (upstream SHOULD → OpenWOP MUST), and
 *   > additionally **MUST** bind the `runId` and the RFC 0051 interrupt token.
 *   > Single use is enforced by consuming the interrupt token — a second retry
 *   > with the same `requestState` **MUST** fail.
 *
 * Every one of those five is in the signed preimage below, and each buys a
 * distinct refusal:
 *
 *   - **principal** — a state minted for caller A cannot be replayed by caller B
 *     to resolve A's gate. Without it, an authenticated tenant could advance
 *     another tenant's approval by observing one `requestState`.
 *   - **TTL** — a state does not outlive the interrupt it resolves.
 *   - **request digest** — the retry MUST be a retry of the SAME request
 *     (`tools/call` name + arguments). Without it a state issued for a harmless
 *     tool would resolve the interrupt of an effectful one.
 *   - **runId + interrupt token** — the state names exactly one gate. The token
 *     is also the single-use mechanism: `mcpSemantics.resumeInterrupt` consumes
 *     the interrupt through the storage CAS, so a verifying-but-replayed state
 *     finds nothing left to resolve.
 *
 * The value is opaque to the peer by construction (base64url of an
 * unstructured payload + MAC); the peer's only obligation is to echo it
 * byte-exactly, which the client half of this host does too
 * (`mcpClient.ts`) — it MUST NOT parse, modify, or infer from it.
 *
 * The signing secret is `readSessionSecret()` — the SINGLE host signing secret
 * (`runStreamToken.ts` precedent), which is fail-closed in production rather
 * than falling back to a per-process ephemeral of its own.
 *
 * @see spec/v1/mcp-integration.md §"MCP 2026-07-28 versioned composition" §C.2
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readSessionSecret } from '../middleware/cookieSession.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.mcpRequestState');

const PREFIX = 'mcp-mrtr:v1';
/** A pending MCP input request is a human answering a form; minutes, not hours.
 *  Independent of (and shorter than) the interrupt token's own TTL, so the
 *  state cannot outlive the round it belongs to. */
const TTL_SECONDS = 15 * 60;

export interface McpRequestStateClaims {
  /** The authenticated MCP caller this state was minted for. */
  readonly principalId: string;
  /** The run whose interrupt this state resolves. */
  readonly runId: string;
  /** The RFC 0051 interrupt being answered. */
  readonly interruptId: string;
  /** The RFC 0051 interrupt token — the capability, and the single-use anchor. */
  readonly interruptToken: string;
  /** Digest of the originating request (method + name + arguments). */
  readonly requestDigest: string;
}

/**
 * The digest of the request an MRTR round belongs to. Stable across the initial
 * call and the retry: the retry carries the SAME `name` + `arguments` and adds
 * only `inputResponses` + `requestState`, which are deliberately excluded.
 */
export function mcpRequestDigest(method: string, name: unknown, args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([method, typeof name === 'string' ? name : null, args ?? null]))
    .digest('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', readSessionSecret()).update(`${PREFIX}:${payload}`).digest('base64url');
}

/** Mint an opaque, integrity-protected `requestState` for one MRTR round. */
export function mintMcpRequestState(claims: McpRequestStateClaims, nowMs: number = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + TTL_SECONDS;
  // The interrupt TOKEN is bound by its digest, not carried: the token is a
  // live capability, and a state the peer holds must not be a way to learn one.
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      exp,
      p: claims.principalId,
      r: claims.runId,
      i: claims.interruptId,
      t: createHash('sha256').update(claims.interruptToken).digest('base64url'),
      d: claims.requestDigest,
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export type McpRequestStateVerdict =
  | { ok: true; runId: string; interruptId: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'principal_mismatch' | 'request_mismatch' };

/**
 * Verify an echoed `requestState` against the retry that carried it.
 *
 * Fail-closed on every axis, and the reason is returned for the LOG only — the
 * wire answer is uniform, so a peer probing for which binding it violated
 * learns nothing.
 */
export function verifyMcpRequestState(
  raw: unknown,
  expect: { principalId: string; requestDigest: string },
  nowMs: number = Date.now(),
): McpRequestStateVerdict {
  if (typeof raw !== 'string' || raw.length === 0) return reject('malformed');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return reject('malformed');
  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard so a malformed state is a
  // clean refusal, not a 500.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reject('bad_signature');
  let claims: { v?: unknown; exp?: unknown; p?: unknown; r?: unknown; i?: unknown; d?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claims;
  } catch {
    return reject('malformed');
  }
  if (claims.v !== 1 || typeof claims.r !== 'string' || typeof claims.i !== 'string') return reject('malformed');
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(nowMs / 1000)) return reject('expired');
  if (claims.p !== expect.principalId) return reject('principal_mismatch');
  if (claims.d !== expect.requestDigest) return reject('request_mismatch');
  return { ok: true, runId: claims.r, interruptId: claims.i };
}

function reject(reason: Exclude<McpRequestStateVerdict, { ok: true }>['reason']): McpRequestStateVerdict {
  // Content-free: the reason class only, never the state, the principal, or the
  // digest it failed against.
  log.info('mcp_request_state_rejected', { reason });
  return { ok: false, reason };
}
