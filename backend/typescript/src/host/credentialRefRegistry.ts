/**
 * Credential-ref referential integrity (ADR 0499).
 *
 * A BYOK secret lives once, in `byok_secrets`, keyed by an opaque `credentialRef`.
 * Config all over the app then NAMES that ref. Nothing kept the two sides in
 * agreement: delete the secret and every config naming it silently became a
 * dangling reference that still validated, still rendered, and failed only when
 * something finally tried to USE it — as a 400 far from the edit that caused it.
 *
 * `routes/adminVault.ts` already answers this WELL (the ENG-2 / SEC-G4 tri-state
 * below, fail-closed with a logged reason). What it could not do is answer it
 * COMPLETELY: its consumer list was hand-written, so it knew about the two
 * bindings someone had remembered to add and none of the others. It did not know
 * about `voice:realtime-config` — the binding that actually dangled in production
 * for a month.
 *
 * So this file changes only the index, not the contract. Every module that
 * persists a `credentialRef` registers a consumer HERE, at module load, exactly
 * as `registerRetentionPurger` does. The delete guard fans out across the
 * registry instead of consulting a list someone has to remember to edit, and the
 * source-scan tripwire in `test/adr0499-credential-ref-integrity.test.ts` fails
 * the build if a credential-holding store ships unregistered. An unregistered
 * holder is the exact failure mode this seam exists to eliminate, so the tripwire
 * is part of the mechanism rather than a nicety.
 *
 * @see docs/adr/0499-credential-ref-referential-integrity.md
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.credentialRefRegistry');

export interface CredentialRefConsumer {
  /** Stable id — surfaces in the tripwire and in failure logs. */
  readonly id: string;
  /**
   * Describe everything in `tenantId` that names `ref`, as operator-actionable
   * strings ("realtime voice provider (gemini-live)").
   *
   * Return EMPTY only when you positively know nothing references it. If the
   * lookup FAILS, throw — the caller turns that into the tri-state's `known:false`
   * arm and refuses the delete. Returning `[]` on error would hand back the
   * permissive answer to an unanswered question, which is the precise bug the
   * tri-state exists to prevent.
   */
  describe(tenantId: string, ref: string): Promise<readonly string[]>;
}

/**
 * The result of a consumer lookup (ENG-2 / SEC-G4), shared by BOTH delete routes.
 *
 * TRI-STATE on purpose. `string[]` conflates the two answers that must never be
 * conflated on a delete path:
 *
 *   "I looked, and nothing uses this"   -> safe to delete
 *   "I could not look"                  -> NOT safe to delete
 *
 * Both render as `[]`, and `[]` flows into `consumers.length > 0` as permission.
 */
export type ConsumerLookup =
  | { known: true; consumers: string[] }
  | { known: false; reason: string };

const consumers = new Map<string, CredentialRefConsumer>();

/** Self-register at module load. Re-registration replaces (module singletons). */
export function registerCredentialRefConsumer(consumer: CredentialRefConsumer): void {
  consumers.set(consumer.id, consumer);
}

/** Registered ids — the tripwire's view of the registry. */
export function listCredentialRefConsumerIds(): string[] {
  return [...consumers.keys()].sort();
}

/** Test seam. */
export function __resetCredentialRefConsumers(): void {
  consumers.clear();
}

/**
 * Everything in `tenantId` that names `ref`. THROWS if any consumer throws —
 * callers must not be able to mistake "one resolver was unavailable" for
 * "nothing references this".
 */
export async function findCredentialRefConsumers(tenantId: string, ref: string): Promise<string[]> {
  const found: string[] = [];
  // Sequential on purpose: admin-rate operation, and a fan-out whose failure we
  // must honour is easier to reason about in order.
  for (const consumer of consumers.values()) {
    let described: readonly string[];
    try {
      described = await consumer.describe(tenantId, ref);
    } catch (err: unknown) {
      log.warn('credential_ref_consumer_failed', {
        consumerId: consumer.id,
        credentialRef: ref,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`consumer "${consumer.id}" could not be enumerated`);
    }
    found.push(...described);
  }
  return found;
}

/**
 * The shared delete-guard lookup. Honest scope, unchanged from what
 * `adminVault` established:
 *
 *  - No tenant context (wildcard admin bearer) -> not knowable here.
 *  - HOST-scoped (scopeless) ref -> resolvable by EVERY tenant, so its consumer
 *    set is not enumerable without a cross-tenant scan. `billing:stripe-key` is
 *    exactly this class, and an under-reporting answer would read as "safe to
 *    delete" on the one secret whose loss silently degrades every checkout.
 *  - Otherwise -> fan out over the registry.
 *
 * Propagates a resolver failure so the caller can log the cause and fail closed.
 */
export async function lookupCredentialRefConsumers(
  tenantId: string | undefined,
  ref: string,
  opts: { hostScoped?: boolean } = {},
): Promise<ConsumerLookup> {
  if (!tenantId) {
    return {
      known: false,
      reason:
        'No tenant context on this request (wildcard admin bearer) — tenant-scoped consumers cannot be enumerated.',
    };
  }
  if (opts.hostScoped) {
    return {
      known: false,
      reason:
        'Host-scoped (scopeless) secrets resolve for EVERY tenant; cross-tenant consumers cannot be enumerated without violating tenant isolation.',
    };
  }
  return { known: true, consumers: await findCredentialRefConsumers(tenantId, ref) };
}
