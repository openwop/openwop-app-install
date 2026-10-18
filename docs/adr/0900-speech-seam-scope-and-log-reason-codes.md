# ADR 0900 — speech seam scope and log reason codes

Status: implemented (D1, D2)

Relates to: ADR 0893 (`VOX2-F1`, `VOX2-F1b`), ADR 0077 P2 (PII log masking), ADR 0733
(value-shaped email mask), ADR 0561 (env API keys scoped by default), ADR 0771 (`dev-token` is not
rewarded).

## Context

### (C) Refusal reasons cannot be counted in Cloud Logging

Post-deploy probes cannot count refusal reasons, because `jsonPayload.reason` arrives hashed
(`pii_<10hex>`). **The hash is ours, not Cloud Logging's.** MEASURED 2026-10-17:
`maskPiiDeep({reason:'keys_disabled'})` returns the value unchanged until
`features/team-intent-ledger/suggestions.ts` loads, and `pii_b3b26fe83e` after it.
That module calls `declarePiiFields('teamLedger.suggestion', ['text','title','reason'])` with the
default `maskGloballyByFieldName: true`, so `reason` joined the entity-agnostic union and every
`reason` key in every log line in the process is pseudonymized.

Removing `reason` from the global PII list is not this ADR's decision: `reason` is free text at many
call sites, and some of them carry user-authored text (a ledger suggestion's reason is exactly that).
The masking is correct for those sites. What is missing is a field that is safe by construction.

### (B) The speech seams are reachable by any signed-in caller

The four RFC 0105/0106 conformance seams
(`POST /host/{openwop-app,sample}/ai/call-speech-synthesizer` and `…/call-transcriber`,
`routes/agents.ts`) are always registered. ADR 0893 gates them on `runs:create` (VOX2-F1) and on a
non-anonymous principal (VOX2-F1b). The user chose that gate on 2026-10-16 (option B). With the
test seam off, any signed-in member still reaches them.

> **DECIDED 2026-10-17 by the user** ("proceed with your recommendations", relayed by the team
> lead): ship D1. For these four seams this supersedes the 2026-10-16 option-B choice, which ADR 0893
> records. Option B's two gates stay and apply behind D1's admission. Synthesis then spends the managed MiniMax
tier on the **platform** key under the per-org ADR 0106 budget. Prod also does not advertise
`aiProviders.speechSynthesis` (MEASURED 2026-10-17 on `/api/.well-known/openwop`), so a 200 there is
an RFC 0105 §C mismatch. No product surface calls these routes. The FE and the podcasts pack reach
TTS through `ctx.callSpeechSynthesizer` inside a run.

> **CORRECTION NOTE (2026-10-17), whatever is decided for D1. ADR 0893's certification premise
> was false.** ADR 0893 states that the prod cut's primary credential is "the `OPENWOP_API_KEYS`
> wildcard bearer". It is not. The prod binding is two SCOPED keys, `…:conformance-prod` and
> `…:conformance-verify` (`scripts/lib/publish-evidence-helpers.mjs:40`). ADR 0893's prediction
> that VOX2-F1 moves no row held for a different reason: the served
> `certification-bundle/major-2` (generated 2026-10-17T16:19:36Z; `openwop-discovery-core` +
> `openwop-core-standard`, both certified; 839 requirement rows) contains no `speech-*` or `voice-*`
> row. Prod also advertises neither `speechSynthesis` nor `realtimeVoice`, and all seven scenarios
> soft-skip on a 404. ADR 0893 is corrected inline.

## Decision

### D2 — a closed-vocabulary `reasonCode` log field that the masking cannot touch (implemented)

- `observability/logReasonCodes.ts` holds `LOG_REASON_CODES`, a `const` tuple of fixed
  `snake_case` literals, and `isLogReasonCode`. Adding a code is a code change with review, never a
  runtime value.
- The logger's field type is `LogFields = Record<string, unknown> & { reasonCode?: LogReasonCode }`,
  so a literal outside the vocabulary fails `tsc`.
- At runtime `emit()` lifts a TOP-LEVEL `reasonCode` out of `fields` before the scrub and mask
  passes (`liftReasonCode`, `observability/logger.ts`). A vocabulary member is written back verbatim
  afterwards, so neither a `declarePiiFields(…, ['reasonCode'])` nor the heuristic can hash it.
  Anything else is DROPPED and replaced by `reasonCodeRejected: true`: free text, an id, a
  non-string, or an untyped `Record<string, unknown>` that bypassed `tsc`. The misuse is visible,
  the value is not. The lift has its own `try`, so a throwing getter cannot throw into a caller.
- Nested `reasonCode` keys are ordinary fields and keep the normal passes.
- The masking of every other field, `reason` included, is unchanged.

Vocabulary: `speech_seam_anonymous` and `speech_seam_insufficient_scope`. Each refusal by the ADR
0893 speech-seam gates emits one `log.info('speech_seam_refused', { reasonCode, route })`. `route`
is the registered path literal, never the request URL. Only an `OpenwopError` 403 from
`requireProtocolScope` counts as `insufficient_scope`. A membership-store fault is not a refusal.

No shared refusal-logging helper exists to retrofit (surveyed 2026-10-17: about 129 ad-hoc
`log.*` refusal sites, none through a common function). D2 therefore wires only the seams, and
other sites adopt `reasonCode` as they are touched.

### D1 — the speech seams admit only test-seam mode or a configured wildcard (implemented)

`speechSeamGate` (`routes/agents.ts`) applies three checks, in order:

1. **Admission.** `OPENWOP_TEST_SEAM_ENABLED === 'true'`, read per request as in
   `hostEventEmitSeam.ts`, OR (`tenants.includes('*')` AND `apiKeysConfigured()`). The `'*'` test is
   the trusted-operator check that `runAccess.ts`, `runs.ts` and `adminVault.ts` already use.
   `apiKeysConfigured()` means the wildcard must be one an operator WROTE (`<key>:*`), never the
   public built-in `dev-token:*` fallback (`apiKeyTenants.ts:70`). That is the ADR 0771 rule
   (`rateLimit.ts:381`), added after /architect M1. Every other caller, anonymous visitors included,
   gets `404 not_found`, "The conformance seam surface is not enabled on this host.". That body is
   byte-identical to what every flag-gated seam sends when its flag is off (`hostEventEmitSeam.ts:40`),
   so a closed seam reads the same as an absent one.
2. **Non-anonymous principal** (VOX2-F1b, unchanged): 401 `anonymous_principal_refused`. After
   admission this is reachable only in test-seam mode, because no anonymous principal carries `'*'`.
3. **`runs:create`** (VOX2-F1, unchanged): 403. Reachable in test-seam mode for a key without the
   scope. A configured wildcard passes it.

No new gate mechanism: the flag check and the wildcard check are two existing predicates combined.
No certified row moves (see the correction note). The prod cut's scoped key gets the 404, and the
seven scenarios soft-skip `blocked` on it, as they do against an unwired seam. The local
conformance lane (`conformance/run.ts`) runs with the test seam on and a `<key>:*` primary, so it is
admitted on both counts.

Under the split commit (`0684b3eb9`), D1 was deferred while the user decided. It is restored
unchanged from `backup/speech-seam-admission` (`f1b820c7f`).

## Alternatives weighed (D2)

- **Remove `reason` from the global PII list.** Re-exposes user-authored `reason` text in logs.
- **Hash-allowlist `reason` values that look like codes (regex).** A regex cannot tell
  `keys_disabled` from a username like `alice_smith`. Only a closed set can.
- **Log the code under `reason` and special-case it in the mask.** That puts free text and codes
  under one key and makes the mask's correctness depend on the value shape again.

## Implementation record

| Phase | What | Witness |
|---|---|---|
| D1 | admission gate in `routes/agents.ts`; the ADR 0893 VOX2-F1/F1b witnesses run in test-seam mode, the only mode where those gates are reachable now; the two real-path seam suites (`speech-synthesis-seam`, `transcriber-tenant-isolation`) configure a `<key>:*` operator key instead of `Bearer dev-token` | `test/adr0900-speech-seam-scope.test.ts`, HTTP. With the flag off, 404 for: a signed-in cookie user, a member `owk_` key WITH `runs:create`, a scoped env key, the `dev-token` fallback, and an anonymous visitor. The cookie user and the member key are each then served <300 by the same caller with the flag on. With the flag off, the configured wildcard is admitted: the handler answers 400 on an empty body (a 200 would need the real provider). With the flag on, the wildcard gets 200, anonymous gets 401 and a key without `runs:create` gets 403. 22 cases RED on `65346ee0f` |
| D2 | `logReasonCodes.ts`; logger lift/validate/restore; every seam refusal emits it | `test/adr0900-log-reason-code.test.ts` (12, through the real stdout sink, with `reasonCode` declared PII): codes survive. A free-text value, an address, a name, an id, a look-alike code outside the set, a number, an object and an array are each dropped and flagged `reasonCodeRejected`, and the value never reaches the line. The D2 block of `adr0900-speech-seam-scope.test.ts`, over HTTP, shows each of the three refusals logs exactly one line with its code and route, and an admitted call logs none |

Sabotage, each restored afterwards:

| Sabotage | Red |
|---|---|
| `admitted = true \|\| …` (no admission gate) | 20 in `adr0900-speech-seam-scope` |
| drop `&& apiKeysConfigured()` (M1) | 4 (the `dev-token` cases) |
| logger skips `liftReasonCode` | 9 of 12 in `adr0900-log-reason-code` |
| `isLogReasonCode` accepts any string | 5 of 12 (the four string cases + the vocabulary case) |
| `speechSeamRefused` logs nothing (measured on the split commit, against the then-equivalent refusal-log witness) | 8 of 12 |

The store-fault branch of the `insufficient_scope` classification has no test (`SPS-1`). Injecting a
membership-store fault over HTTP needs an enforcement-ON boot with a failing store.

## Review record

- **/architect (pre-code, 2026-10-17): APPROVE with changes, 0 Critical / 0 High.** M1 (the D1
  wildcard arm admitted the public `dev-token`) is folded into D1. M2 (RFC 0105
  §C for an admitted caller with the flag off) is `SPS-2`. LOW (test through the real logger sink
  with a `reasonCode` PII declaration, and test at the HTTP boundary) was adopted.
- **/grade-code (2026-10-17): A−, 0 Blocker / 0 High.** `SPS-1` was fixed in the branch; `SPS-2..4`
  are filed (`docs/steward/CODEBASE-ASSESSMENT.md`).

## Open questions / decisions

- [x] **D1: DECIDED 2026-10-17 by the user**: ship it. For these seams it supersedes the 2026-10-16
  option B, whose gates stay behind it.
- [ ] `SPS-2` (narrowed by D1): RFC 0105 §C. A caller that is not admitted now gets the 404 and can
  no longer reach the unadvertised managed-MiniMax 200. The residue is the ADMITTED path outside
  test mode: a configured `<key>:*` operator with the flag off still gets a 200 rather than
  `speech_synthesis_unsupported`. Prod has no wildcard key today (scoped binding).
- [x] Does D1 move a certified row? No (correction note above).
- [x] ADR 0893's "wildcard primary credential" claim is false and is corrected inline there.
