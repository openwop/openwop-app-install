/**
 * CMS content-publish approval handler (ADR 0066).
 *
 * The decide side of the interrupt-backed editorial gate. Submitting a page for
 * review queues a `kind: 'content-publish'` PendingApproval
 * (host/approvalService.ts) UNCONDITIONALLY — this header used to say "when the
 * `cms-approval-gate` toggle is ON", which the chat-first-port C1 change made
 * false and nobody updated (ADR 0593 / CMSAWF-4: same generator, four
 * instances). The toggle gates only the direct-publish BYPASS. A
 * reviewer resolves it from the SAME ApprovalsInbox the assistant/run proposals
 * use; the core approvals routes call this handler for content-publish rows so
 * the inbox claim/reject path and the CMS publish flow share ONE
 * implementation.
 *
 * Direction: feature → core only. Core owns the handler HOOK
 * (`registerContentApprovalHandler`); the CMS feature registers this at boot.
 * Authority is unchanged from the direct routes — `host:members:manage` in the
 * page's org — and is enforced HERE (the generic approvals route is tenant-
 * scoped; content approval adds the org + role dimension + IDOR).
 *
 * @see ../../host/approvalService.ts — the durable queue + the handler hook
 * @see ../../../docs/adr/0066-cms-interrupt-backed-editorial-approval.md
 */

import { OpenwopError } from '../../types.js';
import {
  createContentApproval,
  getApproval,
  findPendingContentApprovalForPage,
  repinContentApproval,
  resolveApproval,
  reopenApproval,
  registerContentApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getOrg, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { getPage, transitionPage } from './cmsService.js';
import { SYSTEM_SITE_ORG, SYSTEM_SITE_TENANT } from '../../host/systemSite.js';

/**
 * ADR 0593 CORRECTION (adversarial review F1/F2) — THE live-content rule.
 *
 * Three sibling gates guard "state that reaches a published page but never moves
 * `page.version`": the shared-section write, the per-page SEO write, and the
 * per-locale publish flip. They shipped as three hand-written copies of one
 * rule, and TWO of them covered only half of it — the SEO gate refused on
 * `published` but not `in_review` (so a canonical URL could be rewritten under a
 * reviewer), and the locale flip was not gated at all (so releasing a withheld
 * machine-drafted overlay on a live page published it instantly).
 *
 * That is the CMSA-1 shape reproduced INSIDE the fix that enumerated its class —
 * the "my fix reintroduces the family it closes" lesson, at the level of the
 * ARMS rather than the members. So the rule gets one owner, and each site states
 * only WHICH page it is asking about.
 *
 * `in_review` is in the set deliberately: the approval pin's closed world is
 * `page.version`, which NONE of these three writes move, so a resubmit cannot
 * make the pin catch up on any of them.
 */
const GATED_LIVE_EDIT_STATES = ['published', 'in_review'] as const;

/** True when a live-content edit must be refused for this page — the ONE
 *  composition of (gate ON) × (not the reserved system site) × (page state). */
export async function refuseLiveEdit(
  tenantId: string,
  orgId: string,
  status: string,
): Promise<boolean> {
  if (!isGatedLiveEditState(status)) return false;
  return liveEditGateActive(tenantId, orgId);
}

/** The PAGE-INDEPENDENT half of the rule: is this org's editorial gate in force
 *  at all? Split out so a fan-out over N pages resolves the toggle ONCE.
 *
 *  It was one `resolveOne` — i.e. one durable store read — PER CANDIDATE PAGE,
 *  and `MAX.perOrgPages` is 2000. Worse than the cost: a toggle flip mid-loop
 *  produced a PARTIALLY gated verdict, which is the CMSA-4 shape ("a decision
 *  taken from a toggle read in an earlier request is not a decision") reduced
 *  from per-request to per-ROW. One read, one decision, whole answer. */
export async function liveEditGateActive(tenantId: string, orgId: string): Promise<boolean> {
  // The reserved system site has no org members, no approvers and no route to
  // one; gating it makes the marketing site unrecoverable (the CMS2-B1
  // correction). Same exemption at every site, for the same reason.
  if (tenantId === SYSTEM_SITE_TENANT || orgId === SYSTEM_SITE_ORG) return false;
  return isApprovalGateOn(tenantId);
}

/** The PAGE half of the rule. */
export function isGatedLiveEditState(status: string): boolean {
  return (GATED_LIVE_EDIT_STATES as readonly string[]).includes(status);
}

/**
 * ADR 0593 §C2 (CMSA-10) — the SAME rule, fanned out over a page SET.
 *
 * A settings-level write (the org's `supportedLocales`) is not about one page:
 * it can release content across every live page at once. Both fan-out sites had
 * hand-written the identical `for (…) if (await refuseLiveEdit(…)) push(…)`
 * loop, which is how this feature's root cause started (three hand-written
 * copies of one predicate, two shipped with half the rule). One owner for the
 * fan-out too, so a later reader cannot get the composition subtly different.
 *
 * The CALLER decides which pages are candidates — i.e. which pages this write
 * would actually change for a reader. That question differs per lane (a shared
 * ref, an added locale) and is not the gate's to answer; the gate answers only
 * "is this page one the org's editorial gate protects right now".
 */
export async function blockingLiveEditPages<T extends { pageId: string; title: string; status: string }>(
  tenantId: string,
  orgId: string,
  candidates: readonly T[],
): Promise<T[]> {
  // §C9 (review F4) — the PAGE half first: it is pure. Hoisting the toggle
  // read above it added a durable read to the all-drafts case, where the
  // loop this replaced did zero. Cheap-and-certain before costly-and-remote.
  const gatedStates = candidates.filter((p) => isGatedLiveEditState(p.status));
  if (gatedStates.length === 0) return [];
  if (!(await liveEditGateActive(tenantId, orgId))) return []; // ONE toggle read
  return gatedStates;
}

/**
 * The refusal itself — and the reason it is a function rather than a string: the
 * REMEDY DIFFERS BY STATE, and the first version named a verb this product does
 * not ship. It told the editor to "withdraw them from review"; `grep -rn
 * withdraw` over the CMS backend and frontend returns exactly one hit — that
 * message. `unpublish` is `{from:['published','archived']}`, so it 409s for an
 * `in_review` page. A refusal that prescribes a nonexistent exit is the
 * gate-with-no-exit shape this same batch closes on the page lane.
 *
 * Both real remedies are admin-tier (`unpublish` and `reject` alike), so the
 * message names the verb AND who holds it, rather than implying self-service.
 */
export function liveEditRefusal(
  what: string,
  pages: readonly { pageId: string; title: string; status: string }[],
  details: Record<string, unknown>,
): OpenwopError {
  const live = pages.filter((p) => p.status === 'published');
  const reviewing = pages.filter((p) => p.status === 'in_review');
  const parts: string[] = [];
  if (live.length > 0) {
    parts.push(`live on ${live.map((p) => `"${p.title}"`).join(', ')} — an admin must unpublish ${live.length === 1 ? 'it' : 'them'} first`);
  }
  if (reviewing.length > 0) {
    parts.push(`under review on ${reviewing.map((p) => `"${p.title}"`).join(', ')} — a reviewer must approve or reject ${reviewing.length === 1 ? 'it' : 'them'} first`);
  }
  return new OpenwopError(
    'conflict',
    `Publishing is gated on approval — ${what} is ${parts.join('; and ')}.`,
    409,
    { gate: 'cms-approval-gate', ...details },
  );
}

/**
 * ADR 0593 (CMSA-D1) — THE `cms-approval-gate` predicate. It had four
 * independent read sites (the routes' local `approvalGateOn`, the publish sweep,
 * the experiment promote lane, and `queueContentApprovalIfGated` below); they
 * agreed by luck, and `CMSA-4` was the first drift. Adding the shared-section
 * gate would have made a fifth. One owner, every lane calls it.
 */
export async function isApprovalGateOn(tenantId: string): Promise<boolean> {
  const gate = await resolveOne('cms-approval-gate', { tenantId });
  return !!gate?.enabled;
}

/**
 * Resolve a content-publish approval: enforce org RBAC + IDOR, flip the approval
 * (CAS), then transition the page (`approve` → published, `reject` → draft).
 * Returns null when the approval is missing/cross-tenant or not a content
 * approval (the route maps that to 404). Throws `forbidden_scope` (403) when the
 * decider lacks `host:members:manage` in the page's org.
 */
async function decideContentPublish(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'content-publish') return null;

  const orgId = approval.orgId ?? '';
  const pageId = approval.pageId ?? '';
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  }

  // IDOR + org-role authority (mirrors `requireOrgScope(req, 'host:members:manage')`,
  // which the generic approvals route cannot apply — it is tenant-scoped).
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantId) {
    // Uniform not-found: never leak a cross-tenant/org approval's existence.
    return null;
  }
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId });
  if (!access.scopes.includes('host:members:manage')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: host:members:manage', 403, {
      requiredScope: 'host:members:manage',
    });
  }

  // ADR 0593 D2 (CMSA-2 / CMSAWF-1) — SUBJECT RE-READ, the terminal backstop.
  //
  // A pending row used to outlive its page with NO exit. Three producers strand
  // one (`deletePage`, `restoreVersion`, the gate-OFF experiment promote), and
  // then BOTH decide arms CAS-resolved, failed the transition, compensated with
  // `reopenApproval` and 404/409'd — forever. Every attempt appended a
  // GOVERNANCE_DECISION entry to the tamper-evident chain and then compensated,
  // so retries polluted it durably, and the inbox card was UNCLEARABLE (the
  // documented DLR2-B3/B4 shape, cured for dealers by
  // `closePendingDealerRegistrationApprovals`).
  //
  // A guard that cannot identify its subject must REFUSE — and must not leave an
  // unclearable card. So: if the page is gone, or has left `in_review` by some
  // other lane, terminally resolve the row and say why. Exactly ONE chain entry
  // is written (the closure); the next attempt hits the pre-existing
  // "already rejected" 409 in `loadPending` and writes nothing.
  //
  // ORDER MATTERS. This sits AFTER the org/IDOR check above: before it, "this
  // page was deleted" would leak to a non-manager who guessed an approvalId,
  // where today they get a uniform null. And it sits BEFORE the CAS, so it can
  // never be confused with the `changed: false` losing-concurrent-decide branch.
  //
  // ATTRIBUTION: the closure passes NO `decidedBy`. Recording the operator who
  // clicked as having "rejected" content that no longer exists would put a
  // human's name on a decision the system made; the note names the cause and the
  // absent actor says the system did it (the dealer cure's shape).
  //
  // …and it must not swallow a LOSING CONCURRENT DECIDE. `loadPending` 409s a
  // non-pending row before the dispatch reaches here, but the row can flip in
  // the window between the two reads: without this guard the loser would be
  // told "the page is now `published`, this review was closed automatically",
  // which is true but attributes to the SYSTEM what another reviewer did. The
  // CAS below would have written nothing either way; what changes is that the
  // 409 now says "already approved", which is what actually happened.
  if (approval.status !== 'pending') return { approval, changed: false };

  const live = await getPage(tenantId, orgId, pageId);
  if (!live) {
    await resolveApproval(approvalId, { status: 'rejected', note: 'Closed automatically — the page was deleted.' });
    throw new OpenwopError(
      'conflict',
      'This review was closed automatically: the page it was about no longer exists.',
      409,
      { reason: 'review_closed', subject: 'deleted', pageId },
    );
  }
  if (live.status !== 'in_review') {
    await resolveApproval(approvalId, {
      status: 'rejected',
      note: `Closed automatically — the page is \`${live.status}\` and is no longer under review.`,
    });
    throw new OpenwopError(
      'conflict',
      `This review was closed automatically: the page is now \`${live.status}\` and is no longer under review.`,
      409,
      { reason: 'review_closed', subject: 'not_in_review', status: live.status, pageId },
    );
  }

  // UX_UPGRADE-content R2 (CMS2-M1) — APPROVE WHAT YOU SAW. The inbox card is
  // rendered from `pageTitle` + `proposal`, both frozen at submit; the page
  // itself is not. An admin may PATCH an `in_review` page (routes.ts re-authorizes
  // to `host:members:manage` and allows it), so between submit and decide the
  // body, the CTA links and the outbound URLs can all change — and
  // `transitionPage('approve')` re-checked only `from:['in_review']` before
  // stamping `publishedVersion` to whatever the page was NOW. The reviewer's
  // name went on content they never read.
  //
  // Checked BEFORE the CAS resolve, so a stale review neither consumes the
  // approval nor needs compensating: the row stays pending and the submitter
  // must resubmit. A REJECT is always allowed — refusing content you did not see
  // is never the unsafe direction, and blocking it would trap the page in review.
  if (outcome === 'approved') {
    if (typeof approval.pageVersion !== 'number') {
      // ADR 0593 (CMSA-7 ⇄ CMSLWF-5) — an UNPINNED row. This used to fall
      // through and publish whatever the page contained at decide time: a guard
      // that cannot identify its subject was silently passing it. The original
      // rationale (a fail-closed default would strand every queued approval on
      // deploy) is right about STRANDING, not about falling through — so the
      // refusal comes with its own exit: pin the row to the live version HERE,
      // so the immediate retry is a real version-checked decision instead of a
      // blind one. One explicit round-trip, never a dead end.
      await repinContentApproval(approvalId, { pageVersion: live.version });
      throw new OpenwopError(
        'conflict',
        'This review was queued before page versions were pinned, so it cannot say which content you are approving. It has been pinned to the current version — re-read the page and decide again.',
        409,
        { reason: 'unpinned_review', currentVersion: live.version, pageId },
      );
    }
    if (live.version !== approval.pageVersion) {
      throw new OpenwopError(
        'conflict',
        'This page changed after it was submitted for review. Re-open it, read the current version, and submit it again.',
        409,
        { reason: 'stale_review', approvedVersion: approval.pageVersion, currentVersion: live.version },
      );
    }
  }

  // CAS flip pending→resolved; `changed` gates the page transition so a losing
  // concurrent decide neither double-publishes nor double-rejects (only the CAS
  // winner transitions). We resolve BEFORE transitioning to keep that gate, then
  // COMPENSATE (re-open) if the transition can't happen — so a failed decide
  // never consumes the approval, and the row never claims "approved" while the
  // page stayed unpublished (review finding HIGH-1 / LOW-4).
  const lock = await resolveApproval(approvalId, {
    status: outcome,
    ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  // Single owner of the status transition — the existing publish path (snapshots
  // the published version). `from:['in_review']` THROWS 409 for a stale page;
  // a deleted page returns null. Either way, restore the approval to pending.
  // The subject re-read above makes both branches unreachable in practice; they
  // stay as defence-in-depth for the window between that read and this write.
  //
  // ADR 0593 D3 (CMSA-3 / CMSAWF-3) — that window is exactly the defect: the pin
  // was CHECK-THEN-ACT. An admin PATCH of the in_review page (legal, admin tier)
  // landing between the version compare above and `transitionPage`'s own blind
  // read-modify-write published content the reviewer never saw, under their
  // name. `expectedVersion` turns the pin into a PRECONDITION carried into the
  // write — a 409 the compensation below already knows how to handle.
  let page;
  try {
    page = await transitionPage(
      tenantId, orgId, pageId, outcome === 'approved' ? 'approve' : 'reject', decidedBy,
      // Approve only: a REJECT must never be version-blocked (see above).
      outcome === 'approved' && typeof approval.pageVersion === 'number'
        ? { expectedVersion: approval.pageVersion }
        : undefined,
    );
  } catch (err) {
    await reopenApproval(approvalId);
    throw err;
  }
  if (!page) {
    await reopenApproval(approvalId);
    return null; // page deleted between submit and decide → 404 (approval stays pending)
  }
  return { approval: lock.approval, changed: true };
}

/** Register the content-publish decision handler on the core approvals hook
 *  (called from the CMS feature at boot). */
export function registerContentApprovalGate(): void {
  registerContentApprovalHandler(decideContentPublish);
}

/*
 * `queueContentApprovalIfGated` was RETIRED in ADR 0593 (CMSA-4 / CMSAWF-2).
 * It was the pre-C1 composition (queue only while the toggle is ON) and its last
 * caller — the experiment-promote lane — had already read the toggle four lines
 * earlier, so the second read was a predicate copy with a flip window: a toggle
 * flipped in between left the page `in_review` with NO approval row on the inbox
 * lane. Post-C1, a submit ALWAYS queues. Use `queueContentApproval`; the toggle
 * question is `isApprovalGateOn` and it belongs to the publish-BYPASS lanes only.
 */

/**
 * ADR 0066 + chat-first-port C1 — queue the `content-publish` approval on a
 * submit-for-review, UNCONDITIONALLY (regardless of the `cms-approval-gate`
 * toggle). This is the ONE decision path: the in_review → approve/reject decision
 * is ALWAYS the shared approval row, resolved through the shared decision core
 * (the CMS `approve`/`reject` header buttons resolve THIS row — never a bespoke
 * page transition). The toggle now gates only whether a DIRECT publish bypass is
 * allowed (OFF ⇒ an admin may publish a draft directly; ON ⇒ publish must go
 * through the review). Idempotent — one open approval per page.
 */
export async function queueContentApproval(
  tenantId: string,
  orgId: string,
  // ADR 0593 CORRECTION (review F8) — `sections` is REQUIRED. It was optional,
  // while the repin below sent `aiDraftedLocales` unconditionally and `[]` means
  // DELETE THE FIELD — so a future caller that omitted `sections` would silently
  // erase an open row's machine-draft disclosure. That is precisely the defect
  // CMSAU-4 closes, re-armed as a latent trap in its own fix. All four current
  // callers pass a full `Page`, so requiring it costs nothing and removes the
  // trap at the TYPE level rather than by convention.
  page: { pageId: string; title: string; version?: number; sections: readonly { aiDrafted?: Record<string, string> }[] },
  proposal?: string,
): Promise<void> {
  // ADR 0593 D4 (CMSAU-4) — DERIVE the machine-draft disclosure from the durable
  // per-section `aiDrafted` stamps (ADR 0592 §3) rather than from this submit's
  // sweep output, so it survives the reject → fix → resubmit loop instead of
  // silently emptying on the second pass. Recomputed on every repin, so it also
  // clears honestly once a human has replaced the drafts.
  const aiDraftedLocales = [
    ...new Set(page.sections.flatMap((s) => Object.keys(s.aiDrafted ?? {}))),
  ].sort();
  // CMS2-M1 fold-in — a RESUBMIT re-pins the open row rather than being dropped.
  // This used to `return` on any pending row, which was correct while the row
  // carried only a title; with a version pin it is what made an edited
  // in-review page unapprovable forever (the pin could never catch up). Still
  // exactly one open approval per page — the idempotency this guard exists for
  // is preserved; what changes is that the open row now tracks the content it
  // claims to be about.
  const pending = await findPendingContentApprovalForPage(tenantId, page.pageId);
  if (pending) {
    await repinContentApproval(pending.approvalId, {
      pageTitle: page.title,
      ...(typeof page.version === 'number' ? { pageVersion: page.version } : {}),
      aiDraftedLocales,
      proposal: proposal ?? `Publish CMS page "${page.title}"`,
    });
    return;
  }
  await createContentApproval({
    tenantId,
    orgId,
    pageId: page.pageId,
    pageTitle: page.title,
    // CMS2-M1 — freeze WHAT is being approved, not just its name. See the
    // staleness check in `decideContentPublish`.
    ...(typeof page.version === 'number' ? { pageVersion: page.version } : {}),
    ...(aiDraftedLocales.length > 0 ? { aiDraftedLocales } : {}),
    proposal: proposal ?? `Publish CMS page "${page.title}"`,
  });
}
