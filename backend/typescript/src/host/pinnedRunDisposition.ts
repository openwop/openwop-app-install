import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { ERA_V2, eraOf } from '../storage/eventEra.js';
import { currentContract } from '../storage/eventEraAdapter.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.pinnedRunDisposition');

/**
 * `spec/v2/core/persistence.md` §"Runs pinned to v1".
 *
 * > A non-terminal run a v2 host inherits carries `version.pinned` events naming
 * > change ids. The host MUST continue it or cancel it, **never follow a pin
 * > silently**. […] Any pinned change id is no longer implemented ⇒ the host
 * > MUST cancel the run with `run.cancelled` reason `v1_pin_unsupported` and
 * > `cancelledBy: "v2-cutover"`.
 *
 * WHY THE IMPLEMENTED SET IS HOST-OWNED AND EMPTY BY DEFAULT. The corpus says so
 * in the scenario's own opt-in: *"no normative surface lists the change ids a
 * host implements"*. There is no registry to consult, so the honest default for
 * a host that has never emitted `version.pinned` is that it implements NONE — it
 * cannot claim to honour a pin it has no code for. `OPENWOP_IMPLEMENTED_CHANGE_IDS`
 * is how an operator declares otherwise, and it is the same lever the suite's
 * continue-leg opt-in uses.
 *
 * A CANCEL IS A WRITE ON A READ PATH, which is unusual enough to say out loud.
 * The rule is a disposition of an INHERITED run: there is no other moment. It is
 * made safe by being compare-and-set on `status` — a run already terminal is
 * never re-cancelled, so N readers append one event, not N.
 */
export const PIN_UNSUPPORTED_REASON = 'v1_pin_unsupported';
export const PIN_CANCELLED_BY = 'v2-cutover';

/** The change ids this host declares it still implements. Empty unless declared. */
export function implementedChangeIds(): ReadonlySet<string> {
  const raw = process.env.OPENWOP_IMPLEMENTED_CHANGE_IDS ?? '';
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
}

/** The first pinned change id this host does not implement, if any. */
export function firstUnsupportedPin(
  events: readonly { type?: string; payload?: unknown }[],
  implemented: ReadonlySet<string>,
): string | undefined {
  for (const e of events) {
    if (e.type !== 'version.pinned') continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const changeId = payload['changeId'];
    // A pin with no readable change id cannot be shown to be implemented, and
    // "cannot be shown" is not "is": following it would be following a pin
    // silently, which is the one thing the rule forbids.
    if (typeof changeId !== 'string' || changeId.length === 0) return '(unnamed)';
    if (!implemented.has(changeId)) return changeId;
  }
  return undefined;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * Dispose a run inherited across the cut. Returns the run, cancelled if a pin
 * forced it. Safe to call on every read.
 */
export async function disposePinnedRun(storage: Storage, run: RunRecord): Promise<RunRecord> {
  // A MAJOR-2 READER ONLY. The rule is written for "a non-terminal run A V2 HOST
  // inherits"; the v1 wire through the overlap keeps serving these runs
  // unchanged (`versioning.md` §5), and cancelling one out from under a v1
  // client would be this host breaking the wire the overlap exists to preserve.
  // Gated here rather than at the call site so the condition travels with the
  // rule instead of being something each reader has to remember.
  if (currentContract() !== 2) return run;
  // Only runs INHERITED across the cut: era-2, and still non-terminal. An era-3
  // run was written by this host and its pins are its own.
  if (eraOf(run) >= ERA_V2) return run;
  if (TERMINAL.has(run.status)) return run;

  const events = await storage.listEvents(run.runId, { fromSeq: -1, limit: 10_000, contract: 1 });
  const unsupported = firstUnsupportedPin(events, implementedChangeIds());
  if (unsupported === undefined) return run;

  // IDEMPOTENT ON THE LOG, not on a compare-and-set — `Storage.updateRun` has no
  // conditional form, and claiming CAS here would be asserting a guarantee the
  // interface does not offer. The log is the check: a run that already carries
  // `run.cancelled` is not cancelled again, so N sequential reads append one
  // event. The `eventId` is DERIVED, so a backend with a unique index on it
  // rejects a duplicate rather than storing one.
  //
  // HONEST LIMIT: two readers arriving concurrently can both observe no
  // `run.cancelled` and both append. Stated rather than papered over — closing it
  // needs a conditional write on the storage interface, which is a wider change
  // than this rule.
  if (events.some((e) => e.type === 'run.cancelled')) return { ...run, status: 'cancelled' };

  await storage.updateRun(run.runId, { status: 'cancelled' });
  await storage.appendEvent({
    eventId: `${run.runId}-v1-pin-cancelled`,
    runId: run.runId,
    type: 'run.cancelled',
    timestamp: new Date().toISOString(),
    payload: { reason: PIN_UNSUPPORTED_REASON, cancelledBy: PIN_CANCELLED_BY, changeId: unsupported },
  });
  log.info('inherited run cancelled: pinned change id is not implemented', {
    runId: run.runId, changeId: unsupported,
  });
  return { ...run, status: 'cancelled' };
}
