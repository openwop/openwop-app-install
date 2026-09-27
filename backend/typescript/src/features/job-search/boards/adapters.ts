/**
 * ADR 0542 D1 (as corrected at P2) — a board adapter is a DESCRIPTOR, not code.
 *
 * Adding a board is a data change: append a descriptor. No deploy, no handler,
 * no `if (board === 'greenhouse')` anywhere. That is the property D1 was
 * protecting and it is preserved exactly.
 *
 * ## Why these are not connection packs
 *
 * The architecture review found two blockers before implementation:
 *
 *  - the connection-pack manifest is the CANONICAL SPEC schema (`$id:
 *    https://openwop.dev/spec/v1/…`, vendored by `scripts/sync-schemas.sh`) with
 *    `provider.additionalProperties: false`. Search/detail entry points cannot
 *    be declared in it without an RFC, and a local edit would be erased by the
 *    next sync;
 *  - its `auth.kind` enum is `oauth2 | api_key | bearer | basic` with no
 *    credential-free option, while every Tier-1 board below is PUBLIC. A pack
 *    for them would advertise a credential model nothing exercises.
 *
 * So the descriptor owns the query shape, and `auth` either says `public` or
 * NAMES a connection-pack provider — which keeps exactly one credential model in
 * the app and inherits the ADR 0285 revocation cascade for boards that need one.
 */

/** How a board is reached. `public` boards need no Connection at all; anything
 *  else names the connection-pack provider whose credential the broker holds. */
export type BoardAuth =
  | { kind: 'public' }
  | { kind: 'connection'; providerId: string }
  /**
   * ADR 0542 D5 Tier 3 — a LICENSED aggregator.
   *
   * Distinct from `connection` because the gate is contractual, not technical:
   * having a credential is not the same as having accepted terms. The adapter is
   * INERT until an operator records acceptance, and `termsUrl` is mandatory so
   * "respected" means a specific document rather than a good intention.
   */
  | { kind: 'licensed'; providerId: string; termsUrl: string; acceptedBy: string; acceptedAt: string };

export interface BoardAdapter {
  /** Stable slug. Also the `sourceBoard` stamped on a listing. */
  id: string;
  displayName: string;
  /** The origin an apply grant must be scoped to for this board (ADR 0541). */
  origin: string;
  auth: BoardAuth;
  /**
   * Submission tier (ADR 0545 D5a). `A` = a documented API, no browser. Recorded
   * per board because the product must be able to say, per saved search, how
   * many matches are actually auto-applicable rather than claiming "most jobs".
   */
  tier: 'A' | 'B' | 'C';
  /**
   * `{company}` is substituted with the board-specific company token. Kept as a
   * template rather than a function so the descriptor stays DATA — a function
   * here would quietly reintroduce the per-board code this exists to avoid.
   */
  searchUrlTemplate: string;
  /** Dotted path to the array of postings in the response. */
  postingsPath: string;
  /** Field mapping from a posting object to our listing shape. */
  map: { title: string; location?: string; url?: string; updatedAt?: string };
  docsUrl: string;
  /**
   * WF-JS-1 — the Tier-A SUBMISSION lane, per board. OPTIONAL and currently
   * implemented by none of the shipped adapters: each board's real submission
   * endpoint needs its own hardened integration (auth posture, multipart shape,
   * error taxonomy), and shipping a fake one would let the pipeline claim
   * listings + mint deals for submissions that never happen. A listing whose
   * adapter lacks the lane is reported `board-no-submit-lane` in the campaign
   * digest — the coverage gap stays a NUMBER the user sees (ADR 0545 D5a), not
   * a silent nothing. When a lane ships it MUST go through the guarded egress
   * dispatcher (ADR 0531/0533 — `assertEffectAllowed` fires at that seam).
   */
  submitLane?: BoardSubmitLane;
}

/** The two halves of a real submission integration (WF-JS-1). `fetchQuestions`
 *  surfaces the board's OWN form so the answer bank answers/parks honestly;
 *  `submit` performs the send. Both receive the stored listing row so an
 *  implementation can read `source_url`/`ext` without re-fetching. */
export interface BoardSubmitLane {
  fetchQuestions(listing: { entityId: string; values: Record<string, string | number | boolean> }): Promise<Array<{ text: string; required: boolean }>>;
  submit(
    prepared: { listingId: string; answers: Record<string, string>; usedKeys: string[] },
    listing: { entityId: string; values: Record<string, string | number | boolean> },
  ): Promise<{ ok: boolean }>;
}

/**
 * Tier-1 boards. All four expose PUBLIC job-board endpoints, which is why none
 * of them carries a credential.
 *
 * Coverage honesty (ADR 0545 D5a): these four are roughly a third of enterprise
 * postings, concentrated in tech startups and scaleups — NOT "most of the
 * market". Workday alone is ~32% and is deliberately absent here because it
 * publishes no public candidate submission API; it is named Tier B in 0545 and
 * gets a hardened adapter of its own rather than being quietly lumped in.
 */
export const TIER_1_BOARDS: readonly BoardAdapter[] = [
  {
    id: 'greenhouse',
    displayName: 'Greenhouse',
    origin: 'boards-api.greenhouse.io',
    auth: { kind: 'public' },
    tier: 'A',
    searchUrlTemplate: 'https://boards-api.greenhouse.io/v1/boards/{company}/jobs',
    postingsPath: 'jobs',
    map: { title: 'title', location: 'location.name', url: 'absolute_url', updatedAt: 'updated_at' },
    docsUrl: 'https://developers.greenhouse.io/job-board.html',
  },
  {
    id: 'lever',
    displayName: 'Lever',
    origin: 'api.lever.co',
    auth: { kind: 'public' },
    tier: 'A',
    searchUrlTemplate: 'https://api.lever.co/v0/postings/{company}?mode=json',
    postingsPath: '',
    map: { title: 'text', location: 'categories.location', url: 'hostedUrl', updatedAt: 'createdAt' },
    docsUrl: 'https://github.com/lever/postings-api',
  },
  {
    id: 'ashby',
    displayName: 'Ashby',
    origin: 'api.ashbyhq.com',
    auth: { kind: 'public' },
    tier: 'A',
    searchUrlTemplate: 'https://api.ashbyhq.com/posting-api/job-board/{company}',
    postingsPath: 'jobs',
    map: { title: 'title', location: 'location', url: 'jobUrl', updatedAt: 'publishedAt' },
    docsUrl: 'https://developers.ashbyhq.com/docs/public-job-posting-api',
  },
  {
    id: 'workable',
    displayName: 'Workable',
    origin: 'apply.workable.com',
    auth: { kind: 'public' },
    tier: 'A',
    searchUrlTemplate: 'https://apply.workable.com/api/v1/widget/accounts/{company}?details=true',
    postingsPath: 'jobs',
    map: { title: 'title', location: 'location', url: 'url', updatedAt: 'published_on' },
    docsUrl: 'https://workable.readme.io/reference/generate-a-job-board',
  },
];

/**
 * Tier 3 ships EMPTY, and that is the honest position rather than an omission.
 *
 * ADR 0542 P3 requires that "an aggregator's terms are respected". Terms cannot
 * be respected for a licence nobody has entered: shipping an Adzuna/USAJOBS
 * adapter here would either hard-code someone else's contractual relationship or
 * pretend acceptance the operator never gave. So the SHAPE and the GATE ship, and
 * an operator registers a licensed adapter once they hold the licence — which is
 * also the only moment `acceptedBy`/`acceptedAt` can be truthful.
 *
 * The gate is enforced by `registerBoardAdapter`, not by convention.
 */
export const TIER_3_BOARDS: readonly BoardAdapter[] = [];

const byId = new Map<string, BoardAdapter>(TIER_1_BOARDS.map((b) => [b.id, b]));

/** Registered adapters. Extending this is a DATA change (append a descriptor). */
export function listBoardAdapters(): readonly BoardAdapter[] {
  return [...byId.values()];
}

export function getBoardAdapter(id: string): BoardAdapter | undefined {
  return byId.get(id);
}

/**
 * Register an additional board at runtime (an operator-supplied descriptor).
 *
 * Last registration wins per id, mirroring `registerFeatureAgentTool`. Kept as a
 * seam so a future operator-authored descriptor store does not need a second
 * lookup path bolted beside this one.
 */
export function registerBoardAdapter(adapter: BoardAdapter): void {
  // A licensed adapter without a recorded, attributable acceptance is refused.
  // The failure is LOUD because the alternative — registering it inert — would
  // look identical to a working board right up until a campaign silently skipped
  // every listing from it.
  if (adapter.auth.kind === 'licensed') {
    const { termsUrl, acceptedBy, acceptedAt } = adapter.auth;
    if (!termsUrl || !acceptedBy || !acceptedAt) {
      throw new Error(
        `board adapter '${adapter.id}': a licensed aggregator needs termsUrl + acceptedBy + acceptedAt — ` +
          'terms cannot be "respected" without a specific document and a person who accepted it (ADR 0542 D5 Tier 3)',
      );
    }
  }
  byId.set(adapter.id, adapter);
}

/** The search URL for a company's board. Returns null for an unknown board. */
export function searchUrlFor(boardId: string, companyToken: string): string | null {
  const b = byId.get(boardId);
  if (!b) return null;
  // `encodeURIComponent` because the token comes from tenant config and lands in
  // a URL — an unencoded token would be a request-splitting surface.
  return b.searchUrlTemplate.replace('{company}', encodeURIComponent(companyToken));
}

/**
 * The origins a grant must cover to auto-apply through these boards (ADR 0541).
 *
 * Exposed so the grant UI can offer real origins rather than asking a user to
 * type a hostname, and so a scope mismatch is a product bug rather than a typo.
 */
export function originsForBoards(boardIds: readonly string[]): string[] {
  return [...new Set(boardIds.map((id) => byId.get(id)?.origin).filter((o): o is string => Boolean(o)))];
}
