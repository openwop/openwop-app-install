/**
 * Which org owns the canvas we were asked to open?
 *
 * The API is org-scoped — `/orgs/:orgId/canvases/:canvasId` — but the app route
 * is `/app-builder/:canvasId`, and `CanvasRecord` carries no `orgId`. So the
 * link is LOSSY: by the time the editor runs, the org that the listing page
 * knew has been thrown away.
 *
 * Every canvas surface used to paper over that with `orgs[0]?.orgId`. For a
 * member of one org that is right by accident. For a member of several it opens
 * the wrong org, and the canvas they clicked — which lives in their second org —
 * comes back 404/403 as a generic load error. They cannot get to it at all.
 *
 * The fix is to stop guessing and carry the org on the link, which is already
 * the house pattern for documents (`DocumentsPage` builds
 * `/documents/:id?org=<orgId>`). This resolves that parameter, and — crucially —
 * reports AMBIGUOUS rather than guessing when it genuinely cannot know.
 *
 * `notMember` is deliberately distinct from `ambiguous`: an `?org=` naming an
 * org the caller does not belong to is a stale link or a probe, and silently
 * falling back to a different org would answer a question that was not asked.
 * The server enforces membership regardless; this keeps the client honest too,
 * and never turns the four surfaces into an oracle for which org holds an id.
 */
import type { Org } from './canvasClient.js';

export type CanvasOrgResolution =
  /** Use this org — either it was named and the caller belongs to it, or there is only one. */
  | { kind: 'ok'; orgId: string }
  /** No org named and the caller has several. We do NOT know; ask. */
  | { kind: 'ambiguous'; orgs: Org[] }
  /** An org was named and the caller is not in it. */
  | { kind: 'notMember'; requested: string }
  /** The caller has no orgs at all. */
  | { kind: 'none' };

export function resolveCanvasOrg(orgs: Org[], requested: string | null | undefined): CanvasOrgResolution {
  if (orgs.length === 0) return { kind: 'none' };

  const asked = requested?.trim();
  if (asked) {
    return orgs.some((o) => o.orgId === asked)
      ? { kind: 'ok', orgId: asked }
      : { kind: 'notMember', requested: asked };
  }

  // Exactly one org is not a guess — there is nothing else it could be.
  const only = orgs[0];
  if (orgs.length === 1 && only) return { kind: 'ok', orgId: only.orgId };

  return { kind: 'ambiguous', orgs };
}
