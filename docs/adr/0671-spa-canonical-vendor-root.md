# ADR 0671 — the SPA moves to the canonical vendor root, and what the move broke

Status: Accepted (implemented; see § Implementation record)

## Context

RFC 0181 (ADR 0652) gave this host's proprietary surface a version-agnostic
address: `/host/<org>/…`. It answers identically with or without a version
header, the header selects nothing there, and — crucially — it does **not**
retire with `/v1`. Its `/v1/host/<org>/…` twin does.

The SPA was entirely on the twin. `check-v1-reliance.mjs` measured
**`spaHostExtensionCallSites: 331`**, and a raw count found **591** occurrences
of `/v1/host/openwop-app` across **242** files (409 in code, 182 in comments).
Every one of those is a migration owed on cutover day.

They did not have to be. The canonical root has worked since ADR 0652 — verified
live before touching anything: `/api/host/openwop-app/orgs` and its `/v1` twin
both answer **200**, `/app-brand` both **403**. Identical status, because the
negotiator rewrites the canonical form onto the twin internally. The Firebase
`/api/**` rewrite covers it, which is the prefix the SPA already uses.

## Decision

Move the SPA off the twin entirely: one mechanical substitution of
`/v1/host/openwop-app` → `/host/openwop-app` across `frontend/react/src`,
comments included, so what the source says is what it sends.

`spaHostExtensionCallSites` **331 → 0**, re-baselined so it cannot regrow.

A chokepoint rewrite inside `requestJson` was the alternative and was rejected:
it would have left 409 misleading literals in the source, where the path you
read is not the path that goes out. That is the defect class this repo keeps
finding, not a fix for it.

## What the move broke, which is the point of this record

The substitution replaced **literals**. Five regexes spell the same path with
**escapes** — `\/v1\/host\/openwop-app\/…` — and matched none of them. So the
URLs moved and the matchers stayed behind:

| site | what it decides | failure direction |
| --- | --- | --- |
| `devtools/networkRecorder.ts` ×2 | whether a BYOK request/response body is **redacted** | **UNSAFE** — plaintext credential material enters the recorder buffer and its sessionStorage mirror |
| `canvas/exportUtils.ts` | whether an SVG `href` is inlined for export self-containment | safe (export loses self-containment) |
| `chat/artifacts/DrawingPreview.tsx` | whether an asset href is a safe host href | safe |
| `chat/mediaSrc.ts` | whether a media src resolves against the API base | safe |

**Every one is an allowlist**, so a spelling it fails to recognise is a silent
miss, and for the redaction pair the silent miss is in the credential-leaking
direction. `threat-model-secret-leakage` caught it — the tests failed with
`expected '{"credentialRef":"openai:default",…}' to be '[redacted: …]'`.

Each regex now takes the `/v1` as optional (`(?:\/v1)?\/host\/…`), which is
correct through the overlap *and* after retirement, rather than being re-pointed
at whichever spelling happens to be current.

**The transferable half: a bulk substitution moves the spelling it was given and
nothing else.** A repo that matches the same path in more than one notation has
as many migrations as it has notations, and only one of them is the one you ran.
The second scan — differently shaped, for escaped forms rather than literal ones
— is what turned four red tests into a bounded class.

A sixth site was a test asserting `/\/v1\/host/` never leaks into UI copy. After
the move that string exists nowhere, so the assertion passed by **absence of the
thing it searched for**. Widened to `(?:\/v1)?\/host\/openwop-app` so it still
measures something.

## Consequences

The SPA no longer depends on the `/v1` path space at all, so retirement day does
not touch it. The remaining v1 reliance is the backend's own
(`backendHostExtensionPathRefs: 755`), which is internal routing rather than a
wire claim — the negotiator rewrites onto it deliberately (the retirement cut-switch, PR #3791).

`check-v1-reliance.mjs`'s failure guidance said a `/v1/host/openwop-app/*` call
site has *"NO v2 home for it yet — that is an open spec question"*. That has been
false since RFC 0181. Corrected in the same commit, since acting on that advice
is what this ADR is.

## Implementation record

| phase | what | where |
| --- | --- | --- |
| 1 | live parity check of twin vs canonical before any edit | measured, not assumed |
| 2 | 591 occurrences / 242 files rewritten; diff pass proved no line changed for another reason | `frontend/react/src` |
| 3 | five escaped-regex matchers widened to accept both spellings | recorder, export, preview, mediaSrc |
| 4 | leak assertion widened so it is not vacuous | `notifications/__tests__/priorityFilter.test.tsx` |
| 5 | ratchet re-baselined 331 → 0; stale "no v2 home" guidance corrected | `scripts/check-v1-reliance.mjs` |
