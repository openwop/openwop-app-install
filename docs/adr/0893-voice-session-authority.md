# ADR 0893 — voice session authority

Status: implemented (2026-10-15; Accepted after the pre-code `/architect` pass below)

**Date:** 2026-10-15 · **Feature:** `voice` (extends ADR 0138 / 0141 / 0142 / 0304 / 0322 / 0324;
toggle id unchanged) · **Origin:** feature loop round 2 row 47 (`docs/steward/FEATURE-LOOP-2026-10.md`),
grade `VOX2WF-1..8` in `docs/steward/WORKFLOWS-ASSESSMENT.md` · **RFC verdict:** host-extension only
(`/v1/host/openwop-app/voice/*`); `runs:create` is already in `scopes_supported`; no wire change.

## Context

Voice runs agent tools and spends the tenant's BYOK provider keys outside the run model: a live call has
no run record, so `runId` is a synthetic `voice:<sid>` (ADR 0138 §7). A typed chat turn gets its
authority from the run machinery (`POST /runs` → `requireProtocolScope(req, 'runs:create')`,
`routes/runs.ts:343`) and re-authenticates on every turn. Voice has to re-create that authority itself.
ADR 0324 brought the TOOL STACK to parity (one allowlist, ADR 0102 set, ADR 0834 conversation gate, one
lane firewall, one scoped executor), and the probes confirm that part holds. What it did not bring over
is the authority that decides who may start a turn and for how long. Probed on `a121883d9`
(`backend/typescript/test/adr0893-voice-session-authority.test.ts`, 12 RED, 4 controls green):

| Id | Finding | Where |
|---|---|---|
| VOX2WF-1 | No voice route checks `runs:create`. A key holding `workspace:write` but not `runs:create` mints realtime sessions, opens the sideband, runs `/tool-call`, and transcribes/speaks on BYOK. | `realtime/routes.ts:184,284,452`, `routes.ts:38` |
| VOX2WF-2 | `/tool-call` resolves the host session by id and tenant only. Another caller in the tenant runs tools as the opener and asserts the opener's one-shot `userApproved`. | `sessionRegistry.ts:136`, `realtime/routes.ts:475` |
| VOX2WF-3 | `POST /realtime/session` on an `openai-realtime` tenant returns an OpenAI client secret to the browser. The FE never uses it (`useRealtimeVoice.ts:109`); its only use is bypassing the sideband. | `openaiRealtime.ts:40-70` |
| VOX2WF-4 | The sideband authorizes once, at connect. A toggle-off or a membership removal does not stop tools for the rest of the call. | `openaiSideband.ts:204` |
| VOX2WF-5 | Spoken user turns are stored with `authorSubject: null`, so DSAR post erasure never matches them. | `openaiSideband.ts:105`, `chatPostErasure.ts` |
| VOX2WF-6 | ADR 0322 BYOK STT/TTS is dead: the walkie adapter has `secrets: {}`, so no ref resolves. The unused body `provider`/`credentialRef` arm would route any vault secret to a TTS vendor once it did. | `routes.ts:85,131-151`, `aiProvidersHost.ts:1951` |
| VOX2WF-7 | Walkie `DELETE` drops buffers and the barge-in turn by raw id before any tenant check. | `routes.ts:236-238` |
| VOX2WF-8 | The agent work snapshot (member-authored portfolio ids, schedule labels) enters the system instructions unfenced. | `voicePreamble.ts:38-50` |

The competitive analysis (`docs/research/2026-06-24-real-time-voice-harness.md` § Infrastructure) puts
"session establishment … admission control" on the edge and "policy checks, tools, and durable state" on
the backend. OpenAI's guidance, which ADR 0141 RT-4 cites, is that tool use belongs on the server. Both
describe the sideband as built. Neither allows a session that keeps authority after its holder has lost
it, or a client-held provider secret.

## Boundaries audit

- **Authority owner:** `host/protocolAuthorization.ts` (`requireProtocolScope`) is the ONE scope gate; voice
  reuses it, not a voice-specific role check. `runs:create` is the scope a chat turn needs, so it is the
  scope a voice turn needs.
- **Membership owner:** `accessControlService.isWorkspaceMember(subject, workspaceId)`, the same predicate
  the auth middleware runs per request (`middleware/auth.ts:1620`). Subject = `callerSubject(req)`.
- **Toggle owner:** `featureToggles/service.resolveToggle` (the req-less form of `requireFeatureEnabled`);
  `voice` is tenant-bucketed, so `{ tenantId }` is its whole subject.
- **Secret owner:** `byok/secretResolver.resolveSecret(ref, { tenantId })`, resolved into the adapter's
  `secrets` the way `host/conversationToolLoop.ts:464` already does.
- **Erasure owner:** `host/chatPostErasure.ts` (matches `authorSubject` by `subjectRefForms`; since the ADR 0464 DSAR-DBL correction, by `subjectKeyForms`, which absorbed it). Voice writes
  the subject; it adds no eraser.
- **Fence owner:** `host/promptInjectionGuard.wrapForLLMPrompt`.
- **No new route, store, toggle, pack, envelope or capability.**

## Decision

- **D1 — a voice turn needs `runs:create`.** One helper, `requireVoiceTurn(req)` in
  `features/voice/voiceAuthority.ts`: the `voice` toggle (as today) and then
  `requireProtocolScope(req, 'runs:create')`. Every route that mints a session, spends a provider key or
  executes a tool calls it: walkie open/audio/commit/speak/barge-in/delete, realtime `session`,
  `openai/connect`, `tool-call`, `held-approvals/resolve`. On `/tool-call` it runs BEFORE the session
  lookup, so a refused caller learns nothing about session ids. Unchanged: `/capability` (a provider id
  only), `/messages/stream` (a conversation read, gated by visibility like the chat read), `/config`
  (superadmin).
- **D2 — a host-issued realtime session answers only its opener.** `/tool-call` resolves the caller and
  refuses with the SAME 403 as an unknown id unless `caller.userId === session.userId`. A session minted
  without a user still answers a caller without one, because that combination carries no acting user and
  so no deliverable-tool or approval authority.
- **D3 — the OpenAI client secret never leaves the host.** `POST /realtime/session` on an
  `openai-realtime` tenant answers `409 realtime_use_sideband`, before the key is resolved. The OpenAI
  adapter's `createSession` stays as the mint primitive for tests but has no route.
- **D4 — the sideband re-authorizes every tool call.** `SidebandSession` carries the opener's `subject`
  (`callerSubject(req)` at connect). Before an ordinary tool call or a delegation, the sideband checks
  that `voice` still resolves enabled for the tenant and, for a shared `ws:` tenant, that the subject is
  still a workspace member. A miss answers the call with
  `[denied] {"error":"voice_session_revoked"}` (the model is told the action did not happen), marks the
  session revoked and closes the sideband after that frame is sent. That ends tools, transcripts and
  persona for the call, the same degraded state ADR 0141 GRADE-15 already describes, and the degraded
  notice is persisted. A held approval (A7) is resolved through an HTTP route that re-authenticates, so
  it needs no second check.
- **D5 — a spoken user turn carries its speaker.** `persistTranscript` stamps `authorSubject: s.subject`
  on `role:'user'` rows (the form `routes/chatSessions.ts` stamps for a typed post). Assistant rows keep
  `null`, as typed assistant rows do.
- **D6 — walkie BYOK resolves server-side, from a server-chosen ref only.** `/commit` and `/speak` pick the
  ref as today (agent voice when authoritative, else the tenant realtime credential), resolve it with
  `resolveSecret(ref, { tenantId })`, and pass `secrets: { [ref]: value }`. The body's `provider` and
  `credentialRef` are no longer read (the FE never sent them; `voiceClient.ts:91`). `voiceId` stays a
  client hint for an unscoped session.
- **D7 — walkie `DELETE` is tenant-bound.** It point-gets the caller's session first; a miss is an
  idempotent `204` that touches nothing.
- **D8 — the work snapshot is fenced.** `voicePreamble.ts` emits the snapshot lines through
  `wrapForLLMPrompt({ contentTrust: 'untrusted', source: 'voice-work-snapshot' })`, with the
  "About your current work" header outside the fence. The file joins the fenced-truncation ratchet as
  `PRODUCES`.

## Architect pass (pre-code, 2026-10-15) — corrections folded into the decisions

An independent adversarial `/architect` review of the text above found 6 High / 7 Medium / 5 Low,
each checked against the code. The decisions above are the ORIGINAL text; these notes override them.

- **H1 → D4 corrected: closing the sideband does not end the persona.** The instructions are applied once
  via `session.update` on open (`openaiSideband.ts:422-427`), and the browser keeps the WebRTC audio, so a
  closed sideband leaves a revoked user talking to a model that still holds workspace context, with no
  notice (`:449-454` posts one only before open). On revoke the sideband now sends a neutral
  `session.update` (empty instructions, no tools), asks OpenAI to end the call
  (`POST /v1/realtime/calls/{call_id}/hangup`, best effort), persists a distinct REVOKED notice (not the
  "reconnect to restore" degraded copy) and then closes. The socket work lives in `openSideband`'s
  handler; `handleSidebandEvent` stays pure and only marks the session revoked.
- **H2 → D4 widened: liveness, and transcripts too.** The check now re-runs the middleware's
  `assertSessionSubjectLive` on the opener's cookie session (erased / disabled / signed-out epoch /
  revoked family), so sign-out ends the call's authority at its next event. That closes the "logout
  mid-call" open question for the cookie lane. It runs before every tool call, delegation AND transcript
  write, so a revoked opener's words stop landing in the conversation.
- **H3 → D6 corrected: provider and ref are chosen as ONE pair.** The old code chose them independently
  (`routes.ts:131-151`), so an agent voice `{provider:'elevenlabs'}` with no ref would be paired with the
  tenant's Gemini/OpenAI realtime key; resolving the ref would then send that key to ElevenLabs. The pair
  is now either the agent's own `{provider, credentialRef}` or the tenant realtime pair, never a mix, and
  `explicitRefNamesOtherProvider` runs before `resolveSecret` (the `conversationToolLoop.ts:459` precedent).
- **H4 → D6 narrowed: OpenAI walkie STT answers honestly.** `transcribeManaged` defaults the model to
  `gemini-2.5-flash` (`aiProvidersHost.ts:561`), and this host's catalog names no OpenAI audio-input model,
  so an `openai-realtime` tenant's walkie commit answers `400 transcription_unsupported` with the reason,
  instead of a 502 from a wrong model id. TTS on the OpenAI key is unaffected. Wiring an OpenAI STT model
  is filed (`VOX2-F2`); it needs a verify-with-key the loop forbids.
- **H5 → filed, not in this ADR.** The core RFC 0105/0106 conformance seams
  (`routes/agents.ts` `call-speech-synthesizer` / `call-transcriber`) have no toggle or scope gate. They
  are the conformance suite's endpoints, they choose the mock arm on `OPENWOP_TEST_SEAM_ENABLED`, and the
  cross-member `streamRef` reach is bounded by D2-style binding on the walkie (M5 below), not by them.
  Gating them changes the certified surface, so it is `VOX2-F1` with its own witness.
- **H6 → D8 corrected: block-aware shedding, and the real truncator is ratcheted.** The instruction cap
  (`realtime/routes.ts:126-133`) did `withoutTranscript.slice(0, 24_000)`, which can cut any fence.
  Instructions are now built by `realtime/instructionBudget.ts`: shed the transcript first, then the
  preamble, as whole blocks; a last-resort cut of the system prompt stops before an unclosed fence. That
  module imports the fence markers from `untrustedContent.ts`, so it enters the fenced-truncation
  population and is classified `TRUNCATES`. Each snapshot line is capped before fencing.
- **M1 → D4 uses `resolveOne` with the opener's `toggleSubjectOf(req)` snapshot**, not `resolveToggle`
  with a bare tenant: the paywall applies and user-level beta cohorts resolve the same as at connect. The
  paywall open question is closed.
- **M2/M6 → bind and compare the SUBJECT, not the user id.** The opener's authority is
  `callerSubject(req)` (a key's membership is checked as its ISSUER, the `credentialAuthority` rule).
  D2 binds the subject at mint and compares it on `/tool-call`; a row without one (minted before this
  ADR, ≤1 h TTL) answers no subject-bearing caller.
- **M3 → D4 re-checks `runs:create`** under `OPENWOP_AUTHORIZATION_ENFORCEMENT`, through the same
  `decideProtocolAuthorization` the route gate uses, with the same wildcard and own-personal-workspace
  escapes, so a member downgraded mid-call loses tools.
- **M4 → parity stated precisely.** `runs:create` is the scope that OPENS a conversation; a later typed
  turn resolves the run's interrupt (`approvals:respond`). So `held-approvals/resolve`, which answers a
  held call, now needs `approvals:respond`; every other voice route needs `runs:create`.
- **M5 → walkie sessions are bound to their opener too.** `VoiceSession.subject` is stamped at open, and
  every walkie route compares it, with one 404 for missing / other tenant / other caller.
- **M7 → the Gemini transcript digest is fenced** as untrusted text inside the instructions (it carries
  other members' words), after budget shedding.
- **Low:** two existing cases flip under D3 (`voice-realtime.test.ts` mint + `credential_unavailable`).
  D1 bites only `owk_` keys while enforcement is off; with it on, a `ws:` Viewer loses voice exactly as
  they cannot `POST /runs`. D5 makes a spoken user row editable/deletable by its speaker through
  `isAuthorOf`, the same as a typed row. A revoked Gemini caller keeps the locked persona until the
  `uses:1` token's ~30 min expiry, but its tools refuse (the tenant re-pin); stated in P2.

## Grade pass on the implementation (2026-10-15) — corrections

`/grade-code voice` (B, 0 Blocker / 2 High) and `/grade-ux voice` (C+, 0 Blocker / 2 High) ran on the first
cut. As on every earlier row, the Highs were in the new code:

- **VOX2CD-1 (High) — D4 hung up every key-opened call.** `sharedTenant = tenant !== personalTenant` is
  true for every key lane (they never set `personalTenant`), and the membership ask then failed for an
  issuer or a `bearer:` id. **Correction:** the snapshot records the auth LANE and each lane keeps the
  presence rule it uses at authentication: `api-key` → `delegationIssuerIsLive` (ADR 0795 D6), `env-key`
  and wildcard → operator (no membership), `session` → the middleware's active ≠ personal ⇒ member rule.
  Witnessed with snapshots built from real request shapes for all five lanes.
- **VOX2CD-2 (High) — a delegation auto-return re-armed a revoked call** (it sent the home persona's full
  instructions and tools over the neutral update). **Correction:** once revoked, `handleSidebandEvent`
  emits only refusals.
- **VOX2CD-3 (Medium) — a store fault ended the call for good, logged as `toggle_off`.** Now
  `authority_unavailable`: the event is refused, the call is not ended.
- **VOX2CD-4/5** — the live teardown (`openSideband` → hang-up, notice, close) is witnessed with a fake
  socket; the hang-up has a 5 s timeout, held approvals are cleared first, and both URLs share one base.
- **VOX2UX-1 (High) — the browser never noticed the host hung up.** `startOpenAiRealtime` now watches
  `connectionState` (`failed`/`closed`; `disconnected` after 5 s) and the hook resets with a toast.
- **VOX2UX-2 (High) — walkie and boardroom failures were silent** (`useVoiceMode.error` was never read).
- **VOX2UX-3/4/6** — the revoked notice renders as a warning with `role=alert` in 4 locales; the
  transcription copy no longer points at a setting that does not exist; a 403 on a held approval is
  "you may not answer this" (card stays pending), not "gone".
- **D4 cost (VOX2CD-8):** each re-check is up to four reads (toggle, liveness, presence, scope under
  enforcement), not "two point-reads" as the Alternatives text below says. Accepted: per tool call and per
  transcript turn, never per audio frame.

Filed with reasons in `docs/steward/CODEBASE-ASSESSMENT.md` / `UX-ASSESSMENT.md` (row 47 sections):
`VOX2CD-6` (an OIDC→user bind mid-session changes the subject; ≤1 h), `-7` (budget edge cases: addendum
dropped on the last-resort cut, surrogate-unsafe `slice(-room)`), `VOX2UX-5` (boards offered on OpenAI
workspaces), `-7` (hard-coded English in voice hooks), `-8` (Gemini tool 403 silent), `-9..14`.

## Implementation record

| Decision | Commit | Witness (`backend/typescript/test/adr0893-voice-session-authority.test.ts` unless noted) |
|---|---|---|
| D1 `runs:create` | `5885ff7c0` | D1 ×4 + control; sabotaged red |
| D2 opener binding | `5885ff7c0` | D2 ×3; sabotaged red |
| D3 no OpenAI client secret | `5885ff7c0` | D3; `voice-realtime.test.ts` flipped case |
| D4 re-auth + teardown | `5885ff7c0`, VOX2CD fix commit | D4 ×6, VOX2CD-1..4; each sabotaged red |
| D5 transcript author | `5885ff7c0` | D5 (DSAR erasure); sabotaged red |
| D6 server-side BYOK pair | `5885ff7c0` | D6 ×2; both sabotaged red |
| D7 tenant-bound DELETE | `5885ff7c0` | D7; sabotaged red |
| D8 fences + block budget | `5885ff7c0` | D8 ×4; `fenced-truncation.test.ts` row; sabotaged red |
| M4 / M5 | `5885ff7c0` | M4, M5; sabotaged red |
| VOX2UX-1/3/6 | FE fix commit | `frontend/react/src/chat/voice/__tests__/voiceSessionAuthorityUx.test.tsx`; each sabotaged red |

## Alternatives weighed

- **A voice-specific role check** (e.g. `workspace:write`). Rejected: the host-ext key lane already asks
  for `workspace:write` on every `/host/*` route, and that is exactly what let the probe key through. The
  question is "may this caller start an agent turn", which `runs:create` answers for chat.
- **Revoke the sideband from the membership-removal and toggle-change code paths** (push, not pull).
  Rejected for now: it needs a cross-instance index of live calls by tenant and subject, and the sideband
  socket is instance-local. A per-call check is two point-reads and catches every path that removes
  authority, including ones nobody wires a hook into. Its gap is a call that makes no tool call after
  removal: it can keep talking (persona only, no tools) until it ends. Stated, not hidden.
- **Keep the OpenAI `/session` mint but log it.** Rejected: an audit line does not restore the tool gate
  or the transcript, and nothing uses the route.
- **Bind the Gemini relay `/tool-call` to the opener by a second secret.** Unnecessary: the caller is
  authenticated on that request, so comparing the caller to the bound opener is the check.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1–D8 in one PR; FEATURES row note; existing `voice-realtime.test.ts` OpenAI `/session` case flips to the 409 | `adr0893-voice-session-authority.test.ts` green; each fix sabotage-checked red |
| P2 (follow-up, filed) | Gemini path transcript audit parity remains ADR 0142's documented lower-assurance lane | — |

## Open questions / decisions

- [x] Scope for a voice turn: `runs:create` (D1).
- [x] What a revoked sideband does: refuse the call, then close (D4).
- [x] Paywall parity in D4 — closed by M1 (`resolveOne`).
- [x] Logout mid-call — closed for the cookie lane by H2 (liveness per event). A bearer/key-opened
  sideband re-checks toggle, membership and scope, not its token's own revocation (residual `VOX2-F3`).
- [x] **`VOX2-F1` — DECIDED 2026-10-16 by the user: gate on `runs:create` (option B).** The four seams now
  pass `requireProtocolScope(req, 'runs:create')` before the handler (`routes/agents.ts`, `speechSeamGate`),
  the same gate as every other voice route (D1). Witness: the `VOX2-F1` block in
  `test/adr0893-voice-session-authority.test.ts` — 4 cases RED on `9e8ee25d0` without the gate, green with it.
  Certification: the cut's primary credential is the `OPENWOP_API_KEYS` wildcard bearer, which
  `requireProtocolScopeIn` passes before any scope decision, so the 7 rows below are predicted NOT to move
  (0 result diffs).
  > **CORRECTED 2026-10-16 (VOX2-F1b) — the scope gate alone did not close it.** MEASURED on prod
  > `5edc98fe6` minutes after it shipped: a cookieless POST to `/api/host/openwop-app/ai/call-speech-synthesizer`
  > minted a fresh `anon:` session and got **200**. Prod runs with `OPENWOP_AUTHORIZATION_ENFORCEMENT` unset,
  > so `requireProtocolScope` narrows only `owk_` keys, and each fresh anon tenant brings its own ADR 0106 TTS
  > budget, so the budget did not bound it either. The seams now refuse an anonymous principal first
  > (`requireNonAnonymousPrincipal`, as every other test seam does), then apply the scope gate. Witness:
  > `test/adr0893-vox2-f1b-speech-seam-anon.test.ts`, booted in the real cookie posture: 4 cases RED on
  > `5edc98fe6`, green with the fix. Same certification prediction: the harness is a wildcard bearer.
  > **CORRECTED 2026-10-17 (ADR 0900): the certification premise above is false.** The prod cut's
  > primary credential is NOT a wildcard bearer. The binding is two SCOPED keys
  > (`…:conformance-prod,…:conformance-verify`, `scripts/lib/publish-evidence-helpers.mjs:40`). The
  > "0 result diffs" prediction held for another reason: the served major-2 certification bundle
  > (2026-10-17T16:19:36Z, 839 rows) has no `speech-*` or `voice-*` row at all, and prod does not
  > advertise `speechSynthesis` or `realtimeVoice`.
  >
  > **CORRECTED 2026-10-17: superseded for these seams by ADR 0900 D1.** The user approved a stricter
  > admission on 2026-10-17. The four seams now admit only `OPENWOP_TEST_SEAM_ENABLED` or a
  > CONFIGURED `<key>:*` principal (never the public `dev-token`). Everyone else gets the flag-off 404,
  > the prod cut's scoped key included. The `runs:create` and non-anonymous gates above still apply,
  > behind that admission. The witnesses above now run in test-seam mode.
  Original filing, kept for the trail:
  **(filed 2026-10-15, not shipped in this row).** The core
  RFC 0105/0106 speech seams (`POST /host/openwop-app/ai/call-speech-synthesizer`, `/host/sample/ai/call-speech-synthesizer`,
  `/host/openwop-app/ai/call-transcriber`, `/host/sample/ai/call-transcriber`; `routes/agents.ts:612-737`) have no
  toggle or scope gate. They CANNOT reach a tenant BYOK key (adapter `secrets: {}`, no provider/ref read from
  the body). Residual: with `OPENWOP_TEST_SEAM_ENABLED` off, synthesis spends the managed MiniMax tier on the
  platform key under the ADR 0106 per-org TTS budget; with it on, both answer from the mock. Options: restrict
  them to the test seam + the conformance/wildcard principal, or gate them on `runs:create`. Gating would move,
  when the certifying credential lacks `runs:create`, these 7 conformance rows: `speech-synthesis-roundtrip`,
  `speech-synthesis-unadvertised` (RFC 0105); `voice-synthesis-streaming`, `voice-transcription-streaming`,
  `voice-streamref-tenant-bound`, `voice-interim-not-durable`, `voice-transcription-unadvertised` (RFC 0106).
- [ ] `VOX2-F2` OpenAI walkie STT model (H4); P2 Gemini transcript audit parity (ADR 0142).
- [x] **`VOX2-F3` token-lane revocation mid-call — CLOSED 2026-10-16.** `voiceAuthorityHolds` now
  re-asks each lane's OWN credential before every sideband event, by the predicates the request lane uses:
  - **OIDC bearer, no cookie riding along:** the snapshot records `{personalTenant, subject, userId?, epoch}`
    (what the bearer lane validated, `req.sessionEpoch`), and `assertBearerSubjectLive` (`middleware/auth.ts`)
    re-reads the row: disabled, erased, or an epoch moved by "sign out everywhere" → `session_not_live`. This
    was the real gap. The lane had no per-event liveness at all, only membership and scope.
  - **`owk_` key:** a revoked or expired key (the ADR 0795 delegation lookup answers null), or keys turned off
    for the workspace (ADR 0798 `tenantKeysDisabled`) → the new lapse `credential_revoked`.
    > Measured before the fix: a REVOKED key already lapsed, because `delegationIssuerIsLive` reads the same
    > lookup and fails, but it was reported as `not_a_member`. Keys turned off for the workspace did NOT
    > lapse. So the key half closes the policy gap and names the lapse honestly; the bearer half closes the
    > liveness gap. Line 233's "not its token's own revocation" overstated the key lane and understated the
    > bearer lane.
  - A definitive liveness refusal ends the call. A store fault (503) now refuses only the current event
    (`authority_unavailable`, VOX2CD-3) on the cookie lane too, which previously ended the call on any throw.
  Witnesses: the `VOX2-F3` block in `test/adr0893-voice-session-authority.test.ts`. All 7 cases are red on
  `60af60cb0`, and four targeted sabotages each red only their own cases: drop the bearer re-check (4), the
  keys-off check (1), the fault/refusal split (1), the key's own liveness check (2).
