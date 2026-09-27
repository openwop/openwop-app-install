/**
 * Comments workflow surface (ADR 0014) — `ctx.features.comments`, a thin adapter
 * over `commentsService` for the feature.comments.nodes pack + reviewer agent.
 * Tenant from the run scope; org-scoped. `post` is the one write — a workflow/agent
 * authored comment, stamped with an `agent:run` author (the run scope carries no
 * human subject; per-subject authorship is the deferred authority refinement).
 *
 * REPLAY / FORK (`WF-CMNT-1`, corrected in place). This header used to claim
 * `post` "is replay-safe because it is called from a `role: "action"` node whose
 * output is recorded (replay/fork read the recorded result, the write is not
 * re-issued)". **Every clause of that was wrong.** `role:"action"` grants no
 * replay protection, and the node's typeId was in neither the derived manifest
 * floor nor the explicit pattern list — so a `:fork` re-ran this function, minting
 * a second row and emitting a second addressed notification. The classification
 * now exists on both legs (`packs/feature.comments.nodes/pack.json`
 * `"role":"side-effect"` + `executor/sideEffects.ts`), so the fast path serves the
 * source run's recorded outcome. Note the protection lives THERE, not here: this
 * function is not idempotent and must never be called outside a classified node.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { assertOrgScope } from '../../host/accessControlService.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listThread, createComment, updateComment, getComment, RESOURCE_TYPES, type ResourceType } from './commentsService.js';
import { emitCommentNotification } from './notifications.js';

const INTERNAL = new Set(['tenantId']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}
const asResourceType = (v: unknown): ResourceType | null => {
  const s = str(v);
  return (RESOURCE_TYPES as readonly string[]).includes(s) ? (s as ResourceType) : null;
};

/** WF-CMNT-2 — typed, and it NAMES the valid enum, matching what the chat tool
 *  already tells a model (`agentTools.ts` `toolEmpty(..., note)`). */
function requireResourceType(v: unknown): ResourceType {
  const rt = asResourceType(v);
  if (!rt) {
    throw new OpenwopError('validation_error', `\`resourceType\` MUST be one of: ${RESOURCE_TYPES.join(', ')}.`, 400, { field: 'resourceType' });
  }
  return rt;
}

/** WF-CMNT-2 — `surfaceStr` coerces an absent `orgId` to `''`, which `listThread`
 *  then filters on and matches nothing. Silent on the read lane, so a chain read
 *  "no comments" from a scoping mistake. Typed here instead. */
function requireOrgId(v: unknown): string {
  const orgId = str(v);
  if (!orgId) throw new OpenwopError('validation_error', '`orgId` is required.', 400, { field: 'orgId' });
  return orgId;
}

export function buildCommentsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  // PROVENANCE — who wrote it. An agent-authored comment is stamped with a stable,
  // opaque, non-PII author so the thread is honest about its origin.
  //
  // ADR 0659 D1: this is NOT the visibility caller. It used to be — `createComment`
  // passed the author into the subject gate — and because `agent:${runId}` is never a
  // bound member, a node could never comment on a subject-bound corpus and was told
  // `not_found`, which was false. Authorship is provenance; visibility is `viewer`.
  //
  // (The line above this one used to read "the run scope has no human subject". That
  // predates `BundleScope.actingUserId`, which 294 sites under src/features now read.)
  const author = `agent:${scope.runId ?? 'run'}`;
  // ADR 0024 §4 — the run owner's DURABLE principal, stamped on
  // `run.metadata.actingUserId` at creation and re-stamped on `:fork`. Absent for
  // SYSTEM runs (schedule / inbound webhook), which is the correct fail-closed
  // signal and is a genuinely reachable lane, not a defensive branch.
  const viewer = scope.actingUserId;

  /**
   * CMNT-4 / WF-CMNT-4 — the membership predicate this lane did not have.
   *
   * `tenantId` came from the run scope (correct), but `orgId` came VERBATIM from
   * node args with no check at all — while `routes.ts` went through
   * `authorizeOrgScope` → `requireOrgScope` and `agentTools.ts` through
   * `resolveReadOrgScope`/`resolveActionOrgScope`. So a chain node in a tenant
   * with several orgs could read AND write comment threads in an org the run had
   * no membership in. The tenant boundary held, so this is intra-tenant
   * cross-org — and the workflow surface was the ONLY lane missing the gate.
   *
   * It now calls `accessControlService.assertOrgScope`, the SAME predicate
   * `requireOrgScope` was refactored onto, rather than a fourth private copy:
   * org-exists-in-tenant (uniform 404) then subject-holds-scope (403).
   *
   * THE REFUSAL HAS A NAMED EXIT. A system run carries no principal, so
   * membership is not "denied", it is UNDEFINED — and answering an undefined
   * authorization question with "yes" is what the finding is. The error therefore
   * says what to do instead (start the run from a human-initiated context, whose
   * `actingUserId` is stamped and survives `:fork`) rather than leaving a caller
   * at a wall. Both lanes are exercised in `comments-surface-authz.test.ts`; the
   * system-run branch is NOT assumed unreachable.
   *
   * Blast radius today: zero chains consume this pack (verified both directions
   * in the workflows grade), so no shipped consumer changes behaviour.
   */
  const requireOrg = async (raw: unknown, needed: 'workspace:read' | 'workspace:write'): Promise<string> => {
    const orgId = requireOrgId(raw);
    if (!viewer) {
      throw new OpenwopError(
        'forbidden_scope',
        'Commenting from a workflow requires an acting user: this run carries no principal, so its organization membership cannot be checked. '
        + 'Start the run from a human-initiated context (the run owner is stamped at creation and survives :fork), or use the comments chat tools.',
        403,
        { requiredScope: needed },
      );
    }
    await assertOrgScope(tenantId, viewer, orgId, needed);
    return orgId;
  };

  return {
    // WF-CMNT-2 — this returned `{comments: []}` for an unrecognized
    // `resourceType`, and (via `str()` coercing a missing org to `''`) for an
    // absent `orgId` too, which the node then reported as `status:'success'`.
    // A consuming chain could not tell that from a genuinely empty thread, so a
    // "read the thread, then decide" step concluded "nothing has been said here"
    // and duplicated — the `WF-ANL-2` false-empty family, the shape that let a
    // model write a Board Update over nothing. The honest idiom was already in
    // this feature three times: `post` and `resolve` throw typed `not_found`,
    // and the chat tool returns `toolEmpty(..., note)` NAMING the valid enum.
    // The read lane was the only silent one; it now fails typed like its
    // siblings.
    list: async (args) => {
      const rt = requireResourceType(args.resourceType);
      const orgId = await requireOrg(args.orgId, 'workspace:read');
      const rows = await listThread(tenantId, orgId, rt, str(args.resourceId), { subject: viewer });
      if (rows === null) throw new OpenwopError('not_found', 'Resource not found in this organization.', 404, { resourceId: str(args.resourceId) });
      return { comments: rows.map(project) };
    },
    post: async (args) => {
      const rt = requireResourceType(args.resourceType);
      const orgId = await requireOrg(args.orgId, 'workspace:write');
      const { comment, notify } = await createComment({
        tenantId, orgId, resourceType: rt, resourceId: str(args.resourceId),
        ...(optStr(args.parentId) ? { parentId: optStr(args.parentId) } : {}),
        // ADR 0659 D1 — the run acts with its INITIATOR's visibility and is attributed to
        // the AGENT that wrote it. D10 — `onBehalfOf` keeps the row reachable by the
        // initiator's erasure (`agent:${runId}` matches no subject key).
        body: str(args.body), authorId: author, caller: { subject: viewer },
        ...(viewer ? { onBehalfOf: viewer } : {}),
      });
      await emitCommentNotification(comment, notify);
      return { comment: project(comment) };
    },
    resolve: async (args) => {
      const commentId = str(args.commentId);
      const orgId = await requireOrg(args.orgId, 'workspace:write');
      const existing = await getComment(tenantId, orgId, commentId, { subject: viewer });
      if (!existing) return { comment: null };
      // CMNT-5 / WF-CMNT-5 — this passed `existing.authorId` as the `actorId`,
      // which is PRECISELY the value `updateComment` compares against for its
      // author-only body-edit guard: the guard was being handed its own
      // comparand by the row it protects, so it was tautologically satisfied.
      // Nothing was bypassed while only `{status:'resolved'}` is patched, but the
      // next person to add `body` to this call would get an ungated
      // edit-anyone's-comment path, and the pattern read as intentional rather
      // than as a landmine. The agent's own stable principal goes in instead (the
      // same value `post` already stamps); resolve is member-level, and the
      // member check is `requireOrg` above.
      const c = await updateComment(tenantId, orgId, commentId, author, { status: 'resolved' }, { subject: viewer });
      return { comment: c ? project(c) : null };
    },
  };
}
