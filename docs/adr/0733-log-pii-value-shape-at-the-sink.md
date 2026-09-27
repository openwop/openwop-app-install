# ADR 0733 — Value-shaped PII at the log sink

Status: Accepted (implemented; see § Implementation record)

Extends **ADR 0077** (data classification, PII log masking, retention). Read that
first; this ADR revives one clause of its Decision §2 that a later correction note
had effectively retracted, and it carries a correction note back to 0077.

## Context

ADR 0077 P2 masks PII in logs by FIELD NAME: `maskPiiDeep` masks the value of a field
whose key is a declared PII field or, under the heuristic, one that
`looksLikePiiName`. That is the right primary control and it is not in question here.

It has a blind spot, and a witness was run before any code was written:

| input field | masked? |
| --- | --- |
| `email: 'bob@example.com'` | yes |
| `error: 'unique violation: alice@example.com'` | **no** — `looksLikePiiName('error')` is `false` |

An address that arrives inside the VALUE of an operational field is not seen, and that
is exactly where a storage or driver error puts one. MEASURED: **233 files** under
`backend/typescript/src` use `error: err instanceof Error ? err.message : String(err)`,
across **~530 log payloads**. A representative live site is
`features/orgs/invitationsService.ts:567`, where the surrounding row carries the
invitee address.

## Decision

Add a VALUE-shaped pass to `maskPiiDeep`, opt-in per call (`values: true`), and wire it
**log-only** at `observability/logger.ts`. Email shapes only. Substring-scoped: the
address is replaced with the existing shared `pii_<10hex>` marker and the rest of the
message survives.

### Why the value pass scans every string leaf, not a key allowlist

The first draft carried an allowlist (`error`, `message`, `reason`, `hint`, `detail`).
The `/architect` pass measured the key distribution and the allowlist was wrong in both
directions: it **missed 53 `err:` sites** and `errorMessage` — the key used by the
global fatal handler at `index.ts:1119` — while including `hint`, which has **zero**
call sites and was there on speculation.

Worse, `err.stack`'s first line **is** `err.message`, so masking `error` while leaving
`stack` puts the identical address on the same log line. Three `stack` sites exist and
they are the three that matter, including the only per-request hot-path error log
(`middleware/errorEnvelope.ts:111-115`).

Both failures have one root cause: **keying on the name again**. So the allowlist is
gone. Every string leaf the key pass did not already replace is scanned.

### Why that is affordable

The `indexOf('@') < 0 → return` guard is not a micro-optimisation, it is what makes
scanning every leaf possible. MEASURED over 1M typical 70-char messages:

| pass | time / 1M | vs baseline |
| --- | --- | --- |
| existing 4 secret regexes | 288 ms | — |
| + email scan, **unguarded** | 1476 ms | +410% |
| + email scan, **guarded** | 336 ms | **+17%** |

### Why not one of the six in-tree email regexes

Six copies of `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` exist. They are ANCHORED validators.
Unanchored as a scanner that shape backtracks super-quadratically — MEASURED on
node v22.22.3 with `'a'*n + '@' + 'b'*n`: 28ms at n=2000, 112ms at n=4000, **465ms at
n=8000**. This runs on the error path over attacker-influenceable strings, some
unbounded (a child process folds captured stdio into its error message). The scanner
here uses bounded character classes with no nested quantifier over the same class, plus
a hard scan cap, and a timing test pins it.

## Alternatives weighed

| alternative | why not |
| --- | --- |
| `errorForLog(err)` helper at call sites | 530+ sites, and the backend has **no ESLint** to enforce it (`"lint": "tsc --noEmit"`). This repo has the case law: `WF-CONS-14` exists because a call-site PII fix landed on the log line and was never carried to the durable write; holding that class needed a source-scanning gate. Right as a later complement for sinks the logger cannot reach, wrong as the primary control. |
| declare `error` a PII field name | masks the WHOLE value, destroying every error message in the backend, and pollutes `allPiiFieldNames` for erasure/export/retention callers. |
| add the pass to `sanitizeFreeText` | **would be a wire change.** That function feeds `node.completed` event payloads, a public unauthenticated chat-widget response body, and `computeArgsHash` — an RFC 0064 replay cache-key PREIMAGE. Changing it breaks determinism against persisted hashes. Pinned by a byte-identity test in this PR. |
| phone numbers too | no measured site, and a digit-run scanner cannot be disambiguated from the operational integers this codebase logs constantly. `looksLikePiiName` was already narrowed once for exactly this over-match reason; repeating it in a VALUE regex, where there is no key to disambiguate, is strictly worse. |

## Residual, stated plainly

- **Logs are not now PII-free.** The same bytes reach at least three other sinks this
  ADR does not touch: `host/exceptionProjection.ts` puts the message in an HTTP
  response body, `errorEnvelope.ts` in `stack`, and `host/isolationAdapter.ts` folds a
  clamped message into run events. The scanner is exported as the SSoT so those sinks
  can reuse it rather than growing a seventh regex.
- **Debuggability cost.** `maskPiiValue` does not normalize case, so correlation holds
  only for byte-identical values. The canonical loss is the bounce/typo workflow:
  `550 5.1.1 user unknown: alcie@example.com` becomes a hash, and the typo *was* the
  diagnosis. Hence the operator off-switch.
- **The sink cannot be kept total.** `console.*` bypasses the logger and there is no
  `no-console` lint to stop the next one (the backend's `"lint"` is `tsc --noEmit`; the
  `eslint-disable-next-line no-console` comments in this tree are decorative).
- **Scanner recall is not total, and the gap is in the local part.** An address whose
  local part uses an RFC-legal special outside `[\p{L}\p{M}\p{N}._%+'-]` (`!#$%&*/=?^`{|}~`)
  masks only from the last in-class run, so `a!b@x.com` leaves `a!` visible. Quoted
  (`"a b"@x.com`) and IP-literal (`a@[192.168.1.1]`) forms do not match at all. Those
  specials are deliberately NOT added: `/`, `?` and `=` would swallow a URL query string
  into a single mask and take the path with it, which costs more debuggability than the
  rare address it would catch.
- **`git@github.com` is masked.** An SSH remote is genuinely email-shaped and cannot be
  told apart from a real address at `github.com`. The repo path survives
  (`pii_<hex>:openwop/openwop-app.git`), so the error stays diagnosable.
- **`warn` severity moves for the routed dispatch line.** It was `console.warn` → stderr,
  which Cloud Logging surfaces as ERROR. `emit()` writes stderr only for `level==='error'`
  and emits `level`, not `severity`, so the line is now DEFAULT severity. Any saved filter
  or alert keyed on it needs updating. Not changed here: making `emit()` send `warn` to
  stderr would move EVERY warn site in the codebase, which is a separate decision.

## § Correction (2026-09-19) — what the code review falsified

Two HIGH defects, both reachable on default settings, both now fixed and pinned:

1. **The scan cap leaked the address it was supposed to bound.** The head/tail split cut
   at a fixed index, so `'x'.repeat(8180) + 'alice@example.com'` put `alice@exampl` (no
   dot, therefore no match) in the scanned head and `e.com` in the verbatim tail — and the
   two concatenated back into a perfectly readable address. `stack` exceeds 8 KB routinely,
   so this was live. The cut now extends forward through any run of address characters,
   bounded by one maximal address (320 chars), so a straddling address lands whole in the
   scanned half. **The original test asserted the leaking behaviour** (`expect(out)
   .toContain(tail)`) and so pinned the defect as the contract; it has been replaced by
   its inverse plus a separate assertion for the cost bound.

2. **`pkg@1.2.3` was email-shaped, so this repo's most common identifier form hashed.**
   The domain allowed an all-numeric final label. MEASURED: `manifest_identity_mismatch:
   requested core.openwop.workflows.crm@1.4.0, got …@1.4.1` (thrown by
   `packs/registryInstaller.ts`, logged by `bootstrap/installRegistryPacks.ts`) became two
   identical-looking hashes, going dark on exactly the pin-drift lane `ENG-PACKS-1` exists
   to debug. The final label must now begin with a letter. Every real TLD does, punycode
   (`xn--p1ai`) included, so this costs no recall. **This ADR had already made the
   argument and not applied it:** it rejected phone scanning because digit runs cannot be
   told from operational integers. A numeric-TLD "email" cannot be told from a semver
   specifier, and the same argument decides it the same way.

Also corrected: the ASCII-only character class silently missed `josé@example.com` and
`alice@münchen.de` (now `\p{L}\p{M}\p{N}` — `\p{M}` because an NFD-decomposed `é` is
`e` + a combining mark, so the composed and decomposed spellings of one address got
different answers); object **keys** were never scanned, so an address-keyed counter emitted
its addresses intact; and the ReDoS test's 100 ms ceiling was ~3x the measurement on a box
this repo has documented at load 144 — it is now a structural assertion on the pattern's
quantifiers, which cannot flake, plus a loose 250 ms ceiling.

## § Correction (2026-09-25) — two more, found by the cleanup program's grading pass

1. **`CLNP-4` — the `msg` string was never PII-masked.** `observability/logger.ts` ran
   only the secret scrub on `msg`, so one address on one line came out masked under a
   field and verbatim in the message. `msg` is reachable from tenant- and AI-authored text
   via the shipped `core.openwop.obs` log node. `test/pii-log-masking.test.ts` **pinned the
   leak as the contract** ("fields-only boundary") — the exact shape the correction above
   warns about, one file over. `msg` now gets the same scrub-then-value-mask pipeline, on
   the same two flags, and the test asserts the inverse (and that msg and field pseudonyms
   for one address are equal).
2. **`CLNP-5` — "starts with a letter" was necessary, not sufficient.** A ONE-letter final
   label still matched, so wildcard pins (`sdk@1.0.x`, `@a2a-js/sdk@1.0.x`, a live string
   in this repo) kept hashing. No delegated TLD is one character; the final label now
   needs two. `a@b.io` still masks. Left over-masked on purpose, and latent: GCP service
   accounts (genuinely email-shaped) and DSN/URL userinfo (`user:pw@host.tld`).

CLNP-5 landed before CLNP-4 in the same change, deliberately: masking `msg` would
otherwise have spread the over-mask into message text.

## Flag

`OPENWOP_LOG_MASK_PII_VALUES` (default ON; `off` disables). Separate from
`OPENWOP_LOG_MASK_PII_HEURISTIC` because it is a different precision/recall trade: the
heuristic guesses at field NAMES, this rewrites VALUES.

## Implementation record

| task | change | witness |
| --- | --- | --- |
| scanner | `maskEmailsInText` in `host/dataClassification.ts`, exported as SSoT | guard + cap tests |
| value pass | `maskPiiDeep(..., { values })`, every string leaf | boundary tests incl. `stack`/`err`/`errorMessage` |
| cap straddle | cut extends through address chars, bounded by `EMAIL_MAX_LEN` | straddle test (replaces the one that pinned the leak) |
| over-mask | final domain label must start with a letter | 5 real semver/pack strings asserted unchanged |
| recall | `\p{L}\p{M}\p{N}` classes | NFC + NFD + punycode + `münchen` asserted masked |
| keys | object keys scanned when `values` is on | address-keyed-counter test |
| wiring | `observability/logger.ts`, log-only, third flag | 3 sink tests in `logger-scrub.test.ts` |
| catch branch | `logFieldsError` scrubbed (it sits OUTSIDE `scrubFields`) | throwing-`toJSON()` test |
| flag is real | `OPENWOP_LOG_MASK_PII_VALUES=off` | module-reset test asserts the address returns |
| bypass | `providers/dispatch.ts` + 3 `voice/realtime/openaiSideband.ts` `console.*` → `log.*` | — |
| wire safety | `sanitizeFreeText` untouched | byte-identity test |
| honesty | corrected two "cannot over-mask" comments + ADR 0077 note | — |

**Not routed, with reasons.** `storage/postgres/schema.ts:781` stays a `console.warn`: the
file is deliberately import-free (pure DDL plus a structural client interface), and the
branch is guarded by `err.message.includes('text_pattern_ops')`, so only an opclass parse
error can reach it — it cannot carry caller data. `observability/tracer.ts` and `metrics.ts`
bracket the observability stack's own init and shutdown. `app-builder/export/backendGen.ts`
is a generated-code string, not a call.

**Sabotage-verified twice.** Removing the value pass from `maskPiiDeep` reds the mechanism
tests. Separately, deleting `values: MASK_PII_VALUES` from `logger.ts:58` now reds
`logger-scrub.test.ts` — before this revision it red nothing, which is precisely the review
finding: the old suite proved the mechanism and never proved the sink used it.
