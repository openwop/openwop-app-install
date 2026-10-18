/**
 * ADR 0889 — a run id arriving in a body/query/path may be the v2 tenant-bound
 * wire spelling (`<tenant>/<opaque>`, identity.md §5). Decode it the way the run
 * routes do; a bound id naming another tenant is indistinguishable from absent.
 */
import { fromWireRunId } from '../v2Ids.js';

export function storedRunId(wire: string, tenantId: string): string | null {
  const r = fromWireRunId(wire, tenantId);
  return r.ok ? r.runId : null;
}
