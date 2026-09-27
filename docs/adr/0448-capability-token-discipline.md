# ADR 0448 — One capability-token discipline: a host helper, hashed-at-rest share links, and the resolver-consolidation rule

| | |
|---|---|
| **Status** | Implemented — 2026-07-20 |
| **Feature** | Architecture extraction + security hardening. **No new feature package, no new toggle, no new wire.** Touches: `sharing` (ADR 0013/0122 — the central capability-link primitive), `kicktodo-core` invites (ADR 0444 I1), `kicktodo-integrations` feed tokens. |
| **Source** | The KickTodo core-value evaluation (this session): the sha256-`tokenHash`-at-rest pattern is hand-copied, and the audit found the CENTRAL sharing primitive stores tokens RAW as row keys — weaker than the pattern its satellites copy. |
| **RFC verdict** | **Host work, no RFC.** Token URL formats and every public route are unchanged; only the at-rest representation and the internal helper change. Nothing on the OpenWOP wire. |
| **Composes** | ADR 0013 (sharing resolver registry), ADR 0122 (share-link snapshots), ADR 0402 (booking + e-signature capability links — the highest-value tokens at risk), ADR 0444 I1 (invites), the KTD-1 purge-safety lesson (tenant IN CONTENT, never only in the key) |

## 1. Why this exists

Three facts, verified in source:

1. **Two features hand-rolled the same hashed token store**: `kicktodo-core/inviteService.ts:36`
   and `kicktodo-integrations/integrationService.ts:87` carry byte-identical
   `hashToken` helpers plus the surrounding discipline (CSPRNG mint, prefix, sha256
   hex key, tenant-in-content, uniform 404). Security-sensitive code kept correct by
   convention and review, not by construction.
2. **The central primitive is WEAKER than its copies**: `sharing/sharingService.ts:389`
   keys the `share:link` collection by the **raw token** (`(l) => l.token`) and
   `FrameView` rows likewise (`:406`). A DB backup, replica, log of keys, or KV dump
   exposes every live capability URL — including the ADR 0402 booking-manage and
   **e-signature** links, which carry real-world authority. The satellites (invites,
   feed tokens) got this right; the hub did not.
3. **The remaining sha256 sites are NOT tokens** (content hashes / dedupe keys in
   forms, cdp, assistant, commerce, kickbot board ids) — they are out of scope, and
   the ADR says so to prevent an over-eager sweep.

Without one owner, the next bearer-token feature flips a coin between the strong and
weak patterns.

**ADR 0446 bar check:** live duplication (two hand-rolled stores) + a hub/satellite
inconsistency in *security* code + a stateless-helper shape — the exact `[1]`
"cross-cutting infra" definition. Passes per-edge judgment, not just the name scan.

## 2. Boundaries audit (verified 2026-07-20)

- **Owner-to-be**: `src/host/` (core; imports `node:crypto` only — no feature imports,
  no storage: the helper is pure; stores stay with their features).
- **Adopters with zero data migration** (hashes are already sha256-hex):
  `kicktodo-invites` (+ `kicktodo-invite-index`), the kicktodo-integrations feed-token
  store.
- **The migration case**: `share:link` rows keyed by raw token; `share:frame-view`
  keyed `${token}:${frame}`. Public routes resolve by token from the URL — a re-key to
  `sha256(token)` is invisible to clients (the raw token still arrives in the URL and
  is hashed before lookup).
- **No route/namespace collisions**: no routes change; no new collections except none.
- **Adjacent rule already half-exists**: sharing's resolver registry (ADR 0013,
  `sharingService.ts:7`) is the intended home for *link-shaped* capabilities — ADR
  0402 used it for bookings/e-sign; ADR 0444's invites did NOT (hand-rolled a token
  store because invites need enroll-time attribution + re-mint revocation). The rule
  in §3 D3 makes the choice explicit instead of accidental.

## 3. Decision

- **D1 — `host/capabilityToken.ts` (pure, ~40 lines).**
  `mintToken(prefix)` → `{ raw: '<prefix>_<base64url 32B CSPRNG>', hash }`;
  `hashToken(raw)` → sha256 hex; plus the documented store discipline as the
  helper's contract: *key = hash; tenant IN CONTENT (purge-safe — KTD-1); verify =
  hash-then-point-get; uniform not-found; never log or return the raw token after
  mint.* Both hand-rolled stores adopt it verbatim (their existing hashes are already
  sha256-hex → **zero data migration**; `ktinv_`/feed prefixes preserved).
- **D2 — sharing goes hashed-at-rest.** `share:link` re-keys to
  `sha256(token)`; the row keeps NO raw token (drop the `token` field after mint —
  mint returns it once); `share:frame-view` re-keys to `${sha256(token)}:${frame}`.
  Lookup paths hash the URL token first. **Migration**: a one-shot boot re-key pass —
  list rows, re-put under the hash key, delete the raw-keyed row — idempotent by
  SHAPE (a key that is already 64-hex is skipped), **not** by a one-shot sentinel
  (the fold lesson: sentinels strand). Mint-time snapshot semantics (ADR 0122) are
  untouched.
- **D3 — the consolidation rule (ARCHITECTURE.md contract line).** New capability
  tokens choose ONE of exactly two homes: (a) **link-shaped** (a URL a human opens →
  a projection) ⇒ a `sharing` resolver (ADR 0013), never a parallel token store;
  (b) **bearer-secret-shaped** (an API/feed/attribution credential) ⇒ a feature-owned
  store built on `host/capabilityToken.ts`. Hand-rolling `createHash` token storage
  outside these two homes is a review-blocking finding.
- **D4 — the tripwire.** A repo test (the banned-pattern style) fails when a
  `DurableCollection` keyed by a `createHash(...)`-derived *token* value appears
  outside `host/capabilityToken.ts` adopters — enforced by an allowlist the test
  owns, so the next copy is a red test, not a review catch. Content-hash uses stay
  exempt (the test matches token mint+store pairs, not `createHash` alone).

## 4. Feature-evaluation matrix (deltas only)

| Dim | Decision |
|---|---|
| Package/toggle | None new; behavior-preserving for every consumer |
| Public surface | UNCHANGED — token URL formats identical; `PUBLIC_PATH_PREFIXES` untouched; uniform 404 posture now uniform by construction |
| RBAC | Unchanged; mint routes keep their existing gates |
| Replay | N/A |
| Node/agent packs, envelopes, FE | None |
| Observability | Helper never logs raw tokens; adopting sites audited for that during migration |

## 5. Phased plan

| Phase | Ships | Gate |
|---|---|---|
| P1 | `host/capabilityToken.ts` + adoption in inviteService + integrationService (zero-migration; existing invite/feed tests pass unmodified) | — |
| P2 | Sharing hashed-at-rest: re-key pass + hashed lookups + drop stored raw token; frame-view re-key | /architect on the migration (idempotency-by-shape, crash-mid-rekey resumability, and the 0402 booking/e-sign links' continuity) |
| P3 | D3 contract line in ARCHITECTURE.md + the D4 tripwire test | P1 |

## 6. Alternatives, corrections, open questions

- **Alternative (rejected): move the invite/feed stores INTO sharing.** Invites need
  enroll-time attribution and re-mint revocation; feed tokens need long-lived
  bearer semantics — neither is a viewer link. Forcing them into `share:link` bends
  the resolver contract; the two-home rule (D3) is the honest split.
- **Alternative (rejected): leave sharing raw-keyed, extract the helper only.** The
  hub carrying the weakest posture while satellites carry the strong one is the
  finding, not a tolerable status quo — 0402's e-signature links are the single most
  authority-bearing tokens in the app.
- **Correction to the evaluation as first stated:** the claim "hand-copied across
  6+ places" was over-counted — most sha256 sites are content hashes. The real
  inventory is 2 token stores + the raw-keyed hub; the ADR scopes to exactly those.
- **OQ1:** should P2's re-key run as a boot pass or an operator-triggered admin
  route? Boot pass preferred (idempotent-by-shape makes it safe to run every boot
  until clean); decide at /architect gate with the crash-resume analysis.
- **OQ2:** rotate-on-migrate? Re-keying does NOT rotate tokens (URLs keep working).
  A deliberate rotation of 0402 e-sign links (invalidate + re-send) is a product
  decision, out of scope; recorded so the migration isn't mistaken for one.

## 7. Implementation record (2026-07-20)

| Phase | Shipped | PR |
|---|---|---|
| P1 | `host/capabilityToken.ts` + zero-migration adoption in kicktodo invites + integrations feed tokens (suites unmodified) | #2268 |
| P2 | Sharing hashed-at-rest: `tokenHash` keys (links + frame views), raw returned once at mint, raw-or-hash entry normalization, boot re-key migration idempotent BY SHAPE (crash-resumable; frame-count merge keeps the larger count) | #2268 |
| P3 | ARCHITECTURE.md two-home seam rows + the D4 tripwire test (`capability-token-tripwire.test.ts`) | #2268 |

**Correction notes:**
- **The management-UX cost was real and accepted** (the P2 /architect gate):
  SharingPage/CmsPage re-showed full raw URLs per link — hashed-at-rest removes
  re-copy permanently. Shipped the PAT show-once model: auto-copy + dismissible
  mint notice; list rows show a fingerprint. i18n chunk budget dated-bump
  213→214 kB (the chunk was at the cliff).
- **Deploy-skew transient**: during a rolling deploy, OLD instances cannot read
  re-keyed rows (their validator requires `token`) — links 404 on old instances
  until they cycle. Bounded, accepted, recorded.
- **The D4 sweep widened the debt inventory**: FOUR more pre-existing mint+hash
  sites (developer-keys apiKeyService, orgs invitationsService, connections
  oauthFlow, commerce ucpClientStore) — beyond this ADR's adoption scope,
  recorded as the tripwire's shrink-only allowlist; each is a follow-up adoption
  (OQ3, new).

## 8. OQ3 resolution — the debt allowlist is emptied (2026-07-20)

The four sites the D4 sweep parked on the tripwire allowlist were worked
per-edge (the ADR 0446 method), and the result splits three-to-one:

| Site | Verdict | What shipped |
|---|---|---|
| `developer-keys/apiKeyService.ts` | ADOPT | `owk_` bearer keys → `mintToken('owk')`; the raw format was already byte-identical (base64url of 32 CSPRNG bytes, sha256-hex hash) ⇒ **zero behavior change**, tests unmodified |
| `orgs/invitationsService.ts` | ADOPT | bare invite token → `mintToken('orginv')` (gains a triage prefix); verification is by hash so existing invites are unaffected |
| `commerce/ucp/ucpClientStore.ts` | ADOPT | both `ucps_` client secret and `ucpt_` access token → `mintToken`/`hashToken`; `timingSafeEqual` secret compare kept; raw widens to 256-bit base64url (hash-verified ⇒ existing clients unaffected) |
| `connections/oauthFlow.ts` | **EXEMPT (false positive)** | its `createHash('sha256')` is the **PKCE S256 `code_challenge`** derivation (RFC 7636) and `state` is an ephemeral single-use CSRF nonce keyed in the pending-auth store — neither is a bearer credential at rest. Reclassified from DEBT to REVIEWED_EXEMPT with the reason inline |

The tripwire now carries an EMPTY debt list + a reasoned exempt list, and a
second assertion fails if any allowlisted file no longer trips the predicate
(so a stale entry can't hide). The two-home rule stands unchanged; the sweep's
"widened debt inventory" (§7) is closed.

**grade-data fix applied (2026-07-20):** `invitationsService.acceptInvitation`
verified the token by a cross-tenant full-collection scan — a violation of the
helper's own "verify = hash then point-get" contract. Added an `orgs:invite-hashidx`
(hash→inviteId) point-get with a legacy scan fallback for in-flight invites; the
index carries `tenantId` in content + a tenant secondary index (KTD-1 purge-safe,
one better than `devkey:hashidx` which can orphan) and ages out in lockstep with
its invite (matching `expiresAt` kvAgeOut, so a reaped invite never strands its
pointer). `ucpClientStore` was already a point-get (`tokens.get(hashToken(raw))`)
— no change needed. Pinned: index created at mint, cleaned on accept + revoke.
