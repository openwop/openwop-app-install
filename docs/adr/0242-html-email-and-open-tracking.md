# ADR 0242 — HTML campaign email + open tracking

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0218 §Deferred "opens" follow-on |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0218 (email engagement, §Deferred), ADR 0217 (suppression), ADR 0226 (owx identity link), ADR 0193 (brokered send) |

## Context

ADR 0218 shipped **plain-text** campaign email with click + unsubscribe tracking
and **deferred opens**, noting: "Opens require an HTML pixel surface; campaign
emails are plain text. Deferred until an HTML template system exists — tracking a
fake 'open' via a text link would be dishonest."

An open signal needs an HTML part to host a 1×1 pixel. The transactional send
spine (`EmailAdapter.send({subject, text?, html?})`) **already builds multipart
text+html** (SendGrid/Postmark); the campaign provider just never passed `html`.

## Decision

- **Auto-render the plain-text body → HTML at send time** — no new template field,
  no authoring UI. A pure `renderHtmlBody(instrumentedText, pixelUrl)` runs AFTER
  `instrumentBody` (so the HTML part carries the SAME tracked `/c` links + the
  unsubscribe/preferences lines): **escape first** (XSS gate — the body is
  operator-authored + interpolated contact fields), then linkify only the
  recognizable host-owned tracked URLs into `<a>`, paragraph-split on blank lines,
  and inject the pixel. Sends **multipart/alternative** (text part unchanged for
  deliverability + no-HTML clients; html part carries the pixel).
- **Open pixel:** `GET /public-email/o/:token` **always** serves a 1×1
  transparent GIF (never a broken image in the inbox), `Cache-Control: no-store`,
  and records an `opened` engagement event only when the opaque `open`-kind token
  resolves. The token is minted per-recipient at send (like the click/unsubscribe
  tokens; no PII in the URL) and injected as `<img …1×1>` into the HTML part only.
  `engagementStats` gains `opens` / `uniqueOpens`.

## Honesty

The pixel is a **real** signal — it fires only when the recipient's client loads
images — NOT a fake text-link open. But opens are **inherently approximate**:
image-blocking clients UNDERCOUNT; proxy-prefetchers (Apple Mail Privacy) can
OVERCOUNT. The stats field is documented as image-load-dependent; opens are never
presented as a precise readership count. A plain-text-only send carries **no**
pixel (no fake opens). We deliberately do NOT build a proxy-prefetch dedup
heuristic (it needs IP/UA fingerprinting the app declines to do).

## Alternatives considered

- **Require an authored `bodyHtml` field now** — DEFERRED. A real HTML authoring
  path (sanitized editor + preview) is its own UX PR; an API-only field is a
  half-feature. Auto-render unblocks opens with zero new authoring surface.
- **Fake open via a text link** — REJECTED, as ADR 0218 noted (dishonest).

## Scope & wire

- No wire/RFC: host-ext receive endpoint under `/public-email/*`, non-normative,
  no capability advert. The `/o` pixel is toggle-independent like `/c`,`/u`,`/p`.
- Replay: opens are read-time recipient-client events, not run-events — outside
  replay/fork. Re-opens are real (no raw-event dedup); `uniqueOpens` dedups by
  contact in the projection.

## Open items (deferred)

- **Authored HTML editor** (a rich-body UI + sanitization + preview) — a later UX PR.
  **DONE — ADR 0256** (authored Markdown SUBSET, not arbitrary HTML: a safe-by-
  construction escape-first renderer + a server-authoritative preview in a
  sandboxed iframe — no allowlist-sanitizer dependency, no `dangerouslySetInnerHTML`).
- **Per-open geo/user-agent** — declined (privacy).
