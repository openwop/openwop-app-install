# ADR 0798 — API keys: visibility, rotation and workspace policy

Status: Accepted (2026-10-01; implemented in the PR that adds this file — see § Implementation record)

- **Follows:** ADR 0800 (a key cannot manage keys; the API keys tab) and ADR 0795
  (a key's authority is its issuer's; explicit scopes; bounded lifetime).
  Tracker rows `KEY-7`, `KEY-8`, `KEY-9`, `KEY-10`, `KEY-11`, `KEY-12`, `KEY-14`,
  `KEY-15`, `KEY-17` in `docs/steward/TODO.md`.
- **Toggle:** none. Developer keys are an always-on surface (ADR 0434).
- **Wire:** untouched. `/v1/host/openwop-app/*` and the SPA only. No RFC.
- **Migration:** none. New optional fields on the key record and one new
  collection (`devkey:policy`); rows written before this read as "not set".

## Context

After ADR 0800 and 0795 a key's authority and lifetime are sound. What it does
and what happens to it are still invisible:

| Gap | State at grading |
|---|---|
| `KEY-7` | Creating or revoking a key wrote nothing to the audit chain and told nobody |
| `KEY-8` | Only operator env keys had a rate bucket of their own; a self-service key shared the per-IP bucket, so a leaked key used from many addresses was never throttled as one caller. `lastUsedAt` carried no origin |
| `KEY-10` | A key found in a log or a repository could not be matched to its row: the list showed a name |
| `KEY-11` | Nobody could say how many keys declare nothing, never expire, or were issued by another key |
| `KEY-12` | Replacing a key meant a gap or two manual steps |
| `KEY-14` | Revoked and expired keys were kept forever |
| `KEY-15` | A workspace could not turn keys off or cap their lifetime |

## Decision

### D1 — a key's life is on the audit chain, and its owner is told (`KEY-7`)

Create, rotate and revoke each append one entry to the tenant's audit chain
(`apikey.created`, `apikey.rotated`, `apikey.revoked`), as does a workspace
policy change (`apikey.policy-changed`) and keys revoked because their issuer
left (`reason: issuer-removed`, with a count). Entries carry ids, scopes,
expiry and the actor — never the key's NAME, which is a person's free text on
an append-only chain. Creating a key also puts a notice in the owner's inbox.

The audit append is a record, not a gate: if it fails, the failure is logged
and the key operation stands. Refusing would hide the key rather than prevent it.

### D2 — a key can be identified without being usable (`KEY-10`)

At mint the record stores a hint, `owk_XXXX…YYYY` (the first and last four
characters of the secret part). The list shows it. Eight of 43 characters of a
256-bit secret identify a row and help nobody guess the rest.

### D3 — one rate bucket per key, and where it was used from (`KEY-8`)

`apiKeyRateLimitMiddleware` counts every request a self-service key makes
against `OPENWOP_RATELIMIT_APIKEY_REQS_PER_MIN` (default 600; 0 turns it off),
in ADDITION to the per-IP buckets. The stamp that records `lastUsedAt` (five-
minute resolution, ADR 0795) also records the address and client it was
presented from.

### D4 — rotation with a bounded overlap (`KEY-12`)

`POST /developer-keys/:id/rotate` issues a replacement with the same name and
scopes, owned by the original's owner, and brings the old key's expiry FORWARD
to now + `OPENWOP_API_KEY_ROTATION_OVERLAP_HOURS` (default 24). It never pushes
an expiry later. The two rows are linked (`rotatedFrom` / `rotatedTo`); a key
that was already rotated cannot be rotated again (rotate its replacement). The
swap on the old row is compare-and-swap, so a revoke that lands meanwhile is not
undone, and a lost swap deletes the replacement rather than leaving two live keys.

Decided with the user: 24 hours. Long enough to switch a deployment over, short
enough that "we will finish rotating later" has an end.

### D5 — retention (`KEY-14`)

A revoked or expired key is kept for `OPENWOP_API_KEY_RETENTION_DAYS` (default
90) and then deleted, record and hash pointer. An expired key ages from its
expiry. The purge runs opportunistically at mint, never on the authentication
path.

### D6 — the workspace's own rules (`KEY-15`)

`GET|PUT /developer-keys/policy`, changed only by an admin or owner:

- **`disabled`** — a kill switch. No key can be created or rotated, and no
  existing key authenticates. It is enforced at authentication (cached per
  tenant for a minute, dropped on the instance that changed it) and is not behind
  a `report` switch: it is the workspace's explicit choice. Revoking stays
  possible, so turning keys off cannot trap one in place.
- **`maxLifetimeDays`** — a cap that can only TIGHTEN the deployment's. A
  workspace with a cap of its own does not issue keys without an expiry.

### D7 — a host-wide inventory (`KEY-11`)

`GET /developer-keys/inventory`, superadmin only: every key by SHAPE — tenant
shape, issuer shape, declaration, expiry state, revoked, used in the last 30
days — and counts of the live ones. No names, hashes, hints or tokens. It exists
to answer what grading could not: how many keys declare nothing, never expire,
or were issued by another key (the ADR 0800 hole).

### D8 — a key can be recognised, and revoked by whoever finds it (`KEY-9`)

**Format.** New keys are `owk_` + 43 base64url characters (32 CSPRNG bytes) +
`_` + 6 characters of CRC-32 over everything before it. The checksum is public
arithmetic, not a secret: it lets a scanner, the leak endpoint and the auth path
tell a real key from a look-alike without a store read. Keys minted before this
(`owk_` + 43 characters) stay valid for as long as they live; anything that is
neither shape never reaches the store. The pattern for a scanner is
`owk_[A-Za-z0-9_-]{43}_[A-Za-z0-9_-]{6}` (`API_KEY_SCAN_PATTERN`).

**Report.** `POST /developer-keys/leaked` takes up to 100 tokens — the
array-of-`{ token, type, url }` shape secret-scanning programmes send, or
`{ tokens: [...] }` — and revokes each live key among them
(`revokedReason: 'leaked'`), records it on the audit chain with the reported
source, and tells the owner at high priority. It answers `true_positive` /
`false_positive` per token.

It is UNAUTHENTICATED, on the public-path list, on purpose: holding the full
secret is all it asks, and anyone holding it could already use the key —
letting them revoke it can only help. It is not an oracle beyond that, since the
caller already has the string. The per-IP rate limit applies.

Decided with the user: apply to GitHub's secret-scanning partner programme. That
registration is the operator's to make (the pattern above and this endpoint are
what it asks for). Until it is made the format and the endpoint work, and nobody
is scanning. A partner's signature on the report is NOT verified here: it is not
needed for safety (the token is the proof), and adding it is worthwhile only
once a partner is sending.

## Deliberately not shipped

- **A per-key address allowlist.** It was built and removed before merge.
  `clientIp` trusts the FIRST `X-Forwarded-For` hop, which the caller sets when
  it reaches the service's direct URL — and this deployment publishes one for
  streaming. An allowlist a client can satisfy by sending a header is worse than
  none: it reads as a control. It needs trusted-proxy hop handling first
  (the same weakness already applies to the per-IP rate buckets).
  > **CORRECTED 2026-10-07:** ADR 0851 (#4516) fixed the reading this depended on
  > (`host/clientIp.ts`). The allowlist is still not shipped, but this is no longer the reason.
- **Re-authentication before mint.** The session cookie's `iat` is refreshed in
  place, so it is not a sign-in time; a real step-up needs the identity
  provider's `auth_time` threaded through. Not attempted here.

## Risks

| Risk | Mitigation |
|---|---|
| The per-key bucket throttles a legitimate integration | 600/min by default, the per-IP read budget's own number; env-tunable; `0` disables. Long-lived SSE streams are exempt, as in the IP limiter |
| The kill switch takes up to a minute to reach another instance | Stated in the code and here; the instance that changed it applies it at once. Acceptable for a switch flipped by hand |
| Rotation leaves two keys live for a day | That is the feature; the old row says it was replaced and shows its end date |
| The inventory is a full scan | Superadmin-only, never on a request path |
| `lastUsedIp` is personal data | It lives on the key record, which erasure deletes (ADR 0795 D6) |

## Implementation record

| Decision | What | Witness (`test/adr0798-key-visibility.test.ts`, 22) |
|---|---|---|
| D1 | `recordKeyEvent` + `notifyKeyCreated` in `features/developer-keys/routes.ts`; the issuer-removed handler | § KEY-7 |
| D2 | `keyHintOf`, `hint` on the record | § KEY-10 |
| D3 | `apiKeyRateLimitMiddleware`; `KeyUseContext` on `verifyApiKey` | § KEY-8 (3) |
| D4 | `rotateApiKey`, the rotate route | § KEY-12 (4) |
| D5 | `purgeDeadKeys` | § KEY-14 (2) |
| D6 | `devkey:policy`, `tenantKeyPolicyCache.ts`, the policy routes, the check in `authMiddleware` | § KEY-15 (4) |
| D7 | `inventoryApiKeys`, the inventory route | § KEY-11 (2) |
| D8 | `mintApiKeyToken`, `isWellFormedApiKey`, `reportLeakedApiKeys`, the leaked route, `LEAKED_KEYS_PATH` on the public-path list | § D8 (5) |
| Docs (`KEY-17`) | `docs/API-KEYS.md`, linked from the README | — |
| Tab | hint, last-used origin, Rotate, the disabled state, the rules card (four locales); moved to `features/developer-keys/` so its catalog loads lazily | `ApiKeysPage.test.tsx` (27) |

Sabotage, one behaviour at a time: removing the hint, the audit calls, the
overlap bound, the rate middleware and the kill-switch check turns five tests
red, one each.

The tab moved from `src/apikeys/` to `src/features/developer-keys/`: a catalog under
`src/<area>/i18n/` is bundled eagerly with the shell, and this PR's strings put
that chunk 312 bytes over its budget. Under `features/` the English catalog
loads with the page.

## Open questions

- [ ] Trusted-proxy hop handling for `clientIp`, then the address allowlist.
- [ ] Step-up before mint, from the identity provider's `auth_time`.
- [ ] Run the inventory on production and act on what it shows (`KEY-11` is the
      tool; reading it needs a superadmin credential).
- [ ] Register the key pattern and the leak endpoint with GitHub's secret-
      scanning partner programme (the operator's action); then verify the
      partner's signature on reports.
- [ ] Per-key usage counts over time (the bucket is in-memory and per instance).
