/**
 * PROPC-ERASURE-DSAR — the per-subject (GDPR data-subject) eraser for the
 * reviewable-learning proposals store (RFC 0096).
 *
 * WHAT WAS WRONG. `features/proposals` registered ZERO `registerSubjectEraser`
 * and ZERO `declarePiiFields`, while every proposal carries `owner.principal` —
 * and that field is NOT an opaque RFC 0048 service principal: the ONE real
 * producer, the ambient-work-graph `accept` route, passes `user.userId`
 * (`features/ambient-work-graph/routes.ts:82`). So `owner.principal` is the
 * accepting person's subject key, exactly the identifier `eraseSubject` is
 * called with on user deletion (`features/users/routes.ts:269` →
 * `eraseSubject(tenantOf(req), req.params.id)`). PROPC-ERASURE-TEARDOWN (the
 * `tenantOf` 4th arg on the collection) covers WHOLE-TENANT deletion, but the
 * per-subject DSAR case ADR 0464 exists for was uncovered: a single member's
 * erasure left their `owner.principal` on every proposal they had accepted.
 *
 * SEMANTICS — REDACT the attribution, KEEP the row (the `assistant:commitment`
 * precedent, `features/assistant/erasure.ts`). A proposal is the workspace's
 * record of a proposed automation (an inert artifact `apply` can install
 * verbatim), not the subject's personal record; deleting it on the accepter's
 * DSAR would destroy org content the org relies on. Only `owner.principal` is
 * the subject datum: the `artifact` byte image is org content (a tool sequence),
 * and `provenance.sourceRunIds` are run pointers, erased via the run lifecycle,
 * not here. The keyFn is `${owner.tenant}::${id}` (NOT `principal`), so redacting
 * the principal never moves or orphans the row.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import type { Proposal } from './types.js';

/** The shared tombstone `owner.principal` becomes — the SAME literal
 *  `crm/erasure.ts`, `assistant/erasure.ts` and `documents/erasure.ts` use, so
 *  one grep finds every tombstone in the app. Not `''` — an empty principal
 *  reads as "nobody set it", a different fact from "erased on request". */
const ERASED_VALUE = 'erased:subject';

// The SAME namespace + key + tenant functions as `proposalsService.ts` — this
// module reads and writes the SAME rows. Declared here rather than exported from
// the service so the erasure seam does not widen the service's public surface
// (the `features/assistant/erasure.ts` / `features/crm/erasure.ts` precedent).
// `test/proposals-erasure.test.ts` asserts the two declarations stay identical.
const proposals = new DurableCollection<Proposal>('proposals', (p) => `${p.owner.tenant}::${p.id}`, undefined, (p) => p.owner.tenant);

/**
 * PII declaration — the CLASSIFICATION seam (distinct from erasure). `owner` is
 * declared entity-AWARE only (`maskGloballyByFieldName: false`, the assistant
 * `owner` precedent): `owner` is a generic field name, so adding it to the
 * app-wide log-mask union would rewrite unrelated operational log keys to
 * `pii_<sha>`. Entity-aware callers (erasure, export, retention) still see it.
 */
declarePiiFields('proposals', ['owner'], { maskGloballyByFieldName: false });

/**
 * The registered eraser. `subjectKey` is a CANDIDATE identifier from any identity
 * space (`subjectErasure.ts` contract); one that matches no `owner.principal` is
 * the harmless no-op the contract describes. Idempotent — an already-tombstoned
 * principal never re-matches, so a re-run reports `rowsTouched: 0`. Fail-closed:
 * an empty tenant or key returns without touching anything (never a tenant sweep).
 */
export async function eraseSubjectProposals(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  let touched = 0;
  for (const p of await proposals.listByPrefix(`${tenantId}::`)) {
    if (p.owner.tenant !== tenantId) continue; // defensive: the prefix scan is tenant-exact, but never write across it
    if (p.owner.principal === undefined || p.owner.principal === ERASED_VALUE) continue; // no subject / already erased
    if (p.owner.principal !== subjectKey) continue;
    await proposals.put({
      ...p,
      owner: { ...p.owner, principal: ERASED_VALUE },
      updatedAt: new Date().toISOString(),
    });
    touched += 1;
  }
  return { rowsTouched: touched };
}

registerSubjectEraser(eraseSubjectProposals);
