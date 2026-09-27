/**
 * Connect-to-continue (ADR 0189 Phase 1) — the mid-run connection prompt.
 *
 * When a connector invocation resolves `connector_no_connection` in an
 * INTERACTIVE run (ctx.interactiveSession — a human chat session created the
 * run and an acting human exists), the invoking node suspends via the
 * normative `ctx.suspend` primitive instead of silently no-opping the step.
 * The chat interrupt card offers Connect (the P9 consent flow) or Skip;
 * resume re-invokes the connector through the SAME authorization choke point
 * (`selectAuthorizedConnection` et al.) — the card never smuggles a
 * credential, it only reports that one now exists.
 *
 * Boundaries (ADR 0033 preserved, byte-identical outside the happy path):
 *  - headless runs (no ctx.interactiveSession) return the graceful
 *    `{ ok: false, error: 'connector_no_connection' }` unchanged;
 *  - a Skip resume (or any unrecognized resume value — fail closed) returns
 *    that same graceful result;
 *  - the prompt carries `timeoutMs` so the interrupt expires (RFC 0093
 *    token expiry); expiry resolution is the lazy auto-skip in
 *    `routes/interrupts.ts` (the open-interrupts read the chat polls).
 *
 * Replay/fork: the deterministic key `conn:<nodeId>:<ref>` short-circuits the
 * suspend on re-invoke (`suspendSignal.ts` §resumeKey) — the recorded resume
 * value (including the `providerId` the card reports) is read verbatim, never
 * re-resolved.
 *
 * Payload conventions (mirrors the core.openwop.hitl form/chat nodes):
 *  - `kind: 'clarification'` is the NodeOutcome/interrupt kind (the suspend
 *    mapping's enum — `suspendSignal.ts` mapSuspendKind);
 *  - `profile: 'openwop-connection'` is the card discriminator (the
 *    `openwop-form` / `openwop-chat` precedent) — NOT `data.kind`, which the
 *    suspend payload reserves (ADR 0189 correction).
 */

import type { NodeContext } from '../executor/types.js';

export const CONNECTION_INTERRUPT_PROFILE = 'openwop-connection';

/** Long enough to complete an OAuth consent round-trip; short enough that an
 *  abandoned prompt expires the same sitting (lazy auto-skip on expiry).
 *  Operator-tunable via `OPENWOP_CONNECTION_PROMPT_TIMEOUT_SEC` (mirrors
 *  `OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC`); read per-suspend so a test or
 *  a deploy can shorten it without a rebuild. */
const DEFAULT_CONNECTION_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;
export function connectionPromptTimeoutMs(): number {
  const raw = process.env.OPENWOP_CONNECTION_PROMPT_TIMEOUT_SEC;
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  }
  return DEFAULT_CONNECTION_PROMPT_TIMEOUT_MS;
}

/** What the suspended node tells the card (lands in `interrupt.data`). */
export interface ConnectionPromptMeta {
  /** The raw binding the node carries (connectionRef or capability token). */
  ref: string;
  /** Resolved provider id, when the ref names one (drives the Connect button). */
  providerId?: string;
  /** Capability category, when the ref is capability-typed. */
  category?: string;
  /** Human label for the card ("BigQuery", "Workday HCM", …). */
  label?: string;
}

export interface ConnectionResume {
  action: 'connected' | 'skip';
  providerId?: string;
}

/** Parse a resume value FAIL-CLOSED: anything that isn't an explicit
 *  `{ action: 'connected' }` reads as skip (expiry, malformed, cancel). */
export function parseConnectionResume(value: unknown): ConnectionResume {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v.action === 'connected') {
      return {
        action: 'connected',
        ...(typeof v.providerId === 'string' && v.providerId ? { providerId: v.providerId } : {}),
      };
    }
  }
  return { action: 'skip' };
}

/** Shape shared by the connector result types this helper wraps. */
interface ConnectorishResult {
  ok: boolean;
  error?: string;
}

/**
 * Run `invoke`; when it resolves `connector_no_connection` in an interactive
 * run, suspend with the connect-to-continue prompt and — on a `connected`
 * resume — re-invoke ONCE through the same choke point. Every other path
 * (headless, skip, expiry, no suspend primitive) returns the original
 * graceful result unchanged.
 */
export async function invokeWithConnectionPrompt<T extends ConnectorishResult>(
  ctx: NodeContext,
  meta: ConnectionPromptMeta,
  invoke: () => Promise<T>,
): Promise<T> {
  const first = await invoke();
  if (first.ok || first.error !== 'connector_no_connection') return first;
  if (!ctx.interactiveSession || !ctx.suspend) return first;

  const resume = await ctx.suspend({
    kind: 'clarification',
    key: `conn:${ctx.nodeId}:${meta.ref}`,
    profile: CONNECTION_INTERRUPT_PROFILE,
    prompt: meta.label
      ? `This step needs a ${meta.label} connection. Connect it to continue, or skip this step.`
      : 'This step needs a connection you have not linked yet. Connect it to continue, or skip this step.',
    connection: { ...meta },
    timeoutMs: connectionPromptTimeoutMs(),
  });

  const parsed = parseConnectionResume(resume);
  if (parsed.action === 'connected') return invoke();
  return first;
}

/**
 * Capability-node variant (ADR 0186 dispatch): the no-connection case there is
 * an EMPTY resolution (no authorized provider for the category), before any
 * invoke. Runs `resolve`; when empty in an interactive run, prompts and — on a
 * `connected` resume — re-resolves ONCE through the same choke point. Returns
 * the (possibly still empty) candidate list; the node's own graceful
 * "not wired" path handles empty exactly as today.
 */
export async function resolveCapabilityWithPrompt(
  ctx: NodeContext,
  category: string,
  resolve: () => Promise<string[]>,
): Promise<string[]> {
  const first = await resolve();
  if (first.length > 0) return first;
  if (!ctx.interactiveSession || !ctx.suspend) return first;

  const resume = await ctx.suspend({
    kind: 'clarification',
    key: `conn:${ctx.nodeId}:capability:${category}`,
    profile: CONNECTION_INTERRUPT_PROFILE,
    prompt: `This step needs a connected ${category} app. Connect one to continue, or skip this step.`,
    connection: { ref: `capability:${category}`, category },
    timeoutMs: connectionPromptTimeoutMs(),
  });

  if (parseConnectionResume(resume).action === 'connected') return resolve();
  return first;
}
