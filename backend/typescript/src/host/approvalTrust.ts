/**
 * ADR 1009 / RFC 0256 §C — who may resolve an approval in a run that read
 * untrusted content.
 *
 * Model and tool content never resolve a gate on their own: every resolution
 * comes through an authenticated lane. What a run's taint changes is WHICH lane.
 * A capability token proves possession of a link, not who holds it (ISWF-23),
 * so an approval that untrusted content may have shaped is refused there and
 * stays open to a session in the app. It is never refused outright: an approval
 * after a read is what `read-then-egress` exists to send to a person.
 *
 * The bit is sticky and lives on `run.metadata`, so the resolve path reads one
 * row. ADR 0755 removed a whole-log read from this path for cost.
 */
import { OpenwopError } from '../types.js';
import type { Storage } from '../storage/storage.js';

export const RUN_UNTRUSTED_CONTEXT_KEY = 'openwop-app.untrustedContext';

/** Atomic and write-once: repeat marks and concurrent nodes cannot race. */
export async function markRunUntrustedContext(storage: Pick<Storage, 'mergeRunMetadata'>, runId: string): Promise<void> {
  await storage.mergeRunMetadata(runId, { [RUN_UNTRUSTED_CONTEXT_KEY]: true }, { ifAbsentKey: RUN_UNTRUSTED_CONTEXT_KEY });
}

/** True for a run that consumed untrusted content, or one an external caller
 *  started across the untrusted boundary (MCP, A2A). A missing run is true:
 *  this answers whether the token lane may decide, and it fails closed. */
export function runHasUntrustedContext(metadata: Record<string, unknown> | undefined | null): boolean {
  if (!metadata) return true;
  return metadata[RUN_UNTRUSTED_CONTEXT_KEY] === true || metadata['trustBoundary'] === 'untrusted';
}

export async function assertApprovalTokenLaneTrusted(
  storage: Pick<Storage, 'getRun'>,
  interrupt: { readonly kind: string; readonly runId: string },
): Promise<void> {
  if (interrupt.kind !== 'approval') return;
  const run = await storage.getRun(interrupt.runId);
  if (!runHasUntrustedContext(run?.metadata)) return;
  throw new OpenwopError(
    'forbidden',
    'This approval can only be decided in the app, because the run read content from outside it.',
    403,
    { reason: 'approval_requires_session', runId: interrupt.runId },
  );
}
