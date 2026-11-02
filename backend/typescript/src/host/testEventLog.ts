/**
 * Test-only in-memory event log. The test seam's emission routes append to it so
 * conformance can inspect an event's shape without driving a full run, and its
 * query endpoint (`GET /v1/host/openwop-app/test/runs/:runId/events`) reads it
 * before falling back to the real run event log.
 *
 * Scope: keyed by runId only (tenantId is implicit since the seam is env-gated
 * and not multi-tenant in production). Cleared via the `resetEventLog()` helper
 * for suite teardown.
 */

/** Minimal RunEvent envelope per schemas/run-event.schema.json
 *  required: { eventId, runId, type, payload, timestamp, sequence }. */
export interface TestRunEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: string;
  readonly sequence: number;
  readonly causationId?: string;
  readonly nodeId?: string;
  readonly contentTrust?: 'trusted' | 'untrusted';
}

const _eventLog = new Map<string /* runId */, TestRunEvent[]>();

/** Append an event to the per-run log. Auto-assigns sequence + eventId
 *  + timestamp from process state if absent. Returns the persisted
 *  event. */
export function appendTestEvent(input: Omit<TestRunEvent, 'sequence' | 'eventId' | 'timestamp'> & Partial<Pick<TestRunEvent, 'sequence' | 'eventId' | 'timestamp'>>): TestRunEvent {
  const arr = _eventLog.get(input.runId) ?? (_eventLog.set(input.runId, []).get(input.runId)!);
  const sequence = input.sequence ?? arr.length;
  const eventId = input.eventId ?? `evt-${input.runId}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = input.timestamp ?? new Date().toISOString();
  const event: TestRunEvent = {
    runId: input.runId,
    type: input.type,
    payload: input.payload,
    sequence,
    eventId,
    timestamp,
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.contentTrust !== undefined ? { contentTrust: input.contentTrust } : {}),
  };
  arr.push(event);
  return event;
}

/** Query the per-run log with optional filters. */
export function listTestEvents(
  runId: string,
  filter: { type?: string; correlationId?: string; causationId?: string; nodeId?: string } = {},
): TestRunEvent[] {
  const arr = _eventLog.get(runId) ?? [];
  return arr.filter((e) => {
    if (filter.type && e.type !== filter.type) return false;
    if (filter.causationId && e.causationId !== filter.causationId) return false;
    if (filter.correlationId && e.causationId !== filter.correlationId) return false;
    if (filter.nodeId && e.nodeId !== filter.nodeId) return false;
    return true;
  });
}

/** Clear ALL test event-log entries (suite teardown). */
export function resetTestEventLog(): void {
  _eventLog.clear();
}
