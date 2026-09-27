# ADR 0454 — One shared iCalendar (ICS) builder (`host/ics.ts`)

| | |
|---|---|
| **Status** | implemented — 2026-07-20 (P1-P3) |
| **Feature** | EXTRACTS a cross-cutting host helper. No new feature package/toggle. |
| **Source** | KickTodo leverage map #3 — re-scoped after audit (see correction). |
| **RFC verdict** | Host work, no RFC. ICS is output text served to external calendar apps; it touches no OpenWOP wire surface. |
| **Composes** | ADR 0402 (crm `ics.ts` booking `.ics`), ADR 0434 (kicktodo feed ICS), ADR 0448 (capability-token — already shared, NOT re-touched here) |

## Boundaries audit (verified file:line) + leverage-map correction

- **CORRECTION to the map's "`kicktodo-feed-tokens`/`renderFeed` is a verbatim reimpl of the capability-token primitive":** the *token layer* is NOT reimplemented. `kicktodo-integrations/integrationService.ts:16,143-146` already mints/hashes feed tokens via `host/capabilityToken.ts` (`mintToken('ktfeed')` + `hashToken`), exactly like `sharing/sharingService.ts:14,568`. Both surfaces already ride the ADR 0448 primitive. The map over-claimed here.
- **The REAL, remaining duplication is the ICS TEXT builder.** There is **no `host/ics.ts`.** Two independent, near-identical RFC 5545 VEVENT/VCALENDAR generators exist:
  - `kicktodo-integrations/integrationService.ts:161-181` — inline in `renderFeed`, with a local `icsEscape` (`:80-86`, RFC 5545 §3.3.11, ADR 0434). Emits a multi-VEVENT calendar feed.
  - `crm/ics.ts` — a standalone "Minimal iCalendar (RFC 5545) VEVENT builder (ADR 0402)" with its own `escapeText`, `icsUtc`, `fold`, `IcsEvent`; consumed by `crm/bookingService.ts` for booking-confirmation `.ics`.
  - Grep for `BEGIN:VCALENDAR|VEVENT|iCalendar` matches ONLY these two — confirmed the full duplication set. `calendarWriteService.ts` writes through a connection transport (RFC 0095), generates no ICS text; commerce has none.
- **The two public surfaces have DIFFERENT lifecycles — do NOT fold the feed into sharing.** Sharing (`sharingService.ts:86` `RESOLVERS`, `:736` `resolveShared`) loads a **snapshot** of ONE resource at `link.createdAt`. The KickTodo feed (`kicktodo-integrations/routes.ts:160`, `/public/kicktodo/feed/:token`) is a **live recurring calendar subscription** (stable URL, no expiry, re-rendered every poll). Adding a `kicktodo_feed` `ResourceType` to the sharing resolver map would mismodel a subscription as a snapshot share. **Rejected.** The feed keeps its own token surface (already capability-token-backed); only the ICS *text* generation is shared.

## Decision

Extract a single **`host/ics.ts`** — the one RFC 5545 builder — and migrate both existing generators onto it:
- Exports: `escapeIcsText(s)` (§3.3.11), `foldIcsLine(s)` (75-octet folding), `icsUtc(date)`, `buildVEvent(IcsEvent)`, `buildVCalendar({ prodId, events, method? })`. `IcsEvent` = `{ uid, start, end?, summary, description?, location?, url?, sequence?, status? }`.
- `crm/ics.ts` becomes a thin re-export/adapter (or is deleted, its callers pointed at `host/ics.ts`) — behavior-preserving; booking `.ics` byte-output pinned by a golden test before/after.
- `kicktodo-integrations/renderFeed` builds its multi-VEVENT feed via `buildVCalendar` + `buildVEvent`, dropping the local `icsEscape`. The public route, token layer, consent gate, and uniform-404 are untouched.

One escape/fold implementation, RFC-5545-correct in one place, is the whole win: today a fix to line-folding or escaping (e.g. a comma/newline bug) must be made twice and can drift between the booking `.ics` and the challenge feed.

## Data model
None. Pure code extraction; no store, no route, no toggle.

## Phased plan
| Phase | Ships | Status |
|---|---|---|
| P1 | `host/ics.ts` (`escapeIcsText`/`foldIcsLine`/`icsUtc`/`buildIcsCalendar`) + `test/host-ics.test.ts` (escape incl. U+2028/9, fold at 75/74, both event shapes byte-exact) | ✅ implemented 2026-07-20 |
| P2 | `crm/ics.ts` → thin adapter over `buildIcsCalendar` (booking `.ics` byte-identical; `crm-booking*` tests green) | ✅ implemented 2026-07-20 |
| P3 | `kicktodo-integrations/renderFeed` → `buildIcsCalendar`, local `icsEscape` removed (feed tests green; injection-safety preserved) | ✅ implemented 2026-07-20 |

> **Correction (P1, 2026-07-20) — "byte-parity with both current builders" was not achievable, by design.**
> The two hand-rolled builders *disagreed*: `crm/ics.ts` was already spec-correct
> (folds at 75 octets, trailing CRLF, superset escape), while kicktodo's
> `renderFeed` did **not** fold, emitted **no trailing CRLF**, and escaped a
> near-superset. One spec-correct shared builder therefore gives **crm exact
> byte-parity** (its tests pin the substrings + trailing CRLF, all green) but
> makes the **kicktodo feed change**: long `SUMMARY` lines now fold and the
> document gains a trailing CRLF. Both are **RFC 5545 correctness fixes**, not
> regressions — the kicktodo tests assert with `toContain`/injection-safety
> (single `SUMMARY:` line, escaped `\n`, no injected property), which all still
> hold. The shared escape is the superset (neutralises U+2028/U+2029), so the
> injection guard is at least as strong as before for every field.

## Alternatives weighed
- **Fold the KickTodo feed into the sharing `RESOLVERS` map** (the map's #3 framing): rejected — subscription vs snapshot lifecycle mismatch (above). The token layer is already shared; nothing to unify there.
- **Leave two ICS builders**: rejected — RFC 5545 escaping/folding is exactly the kind of fiddly spec code that must live once (drift risk is real and silent — a malformed `.ics` just fails in the user's calendar app, no server error).

## Open questions
- OQ1: keep `crm/ics.ts` as a re-export shim (smaller diff, preserves ADR 0402 import paths) or delete + repoint callers? Lean shim in P2, delete in a follow-up.
- OQ2: does `host/ics.ts` belong in `host/` (cross-cutting, like `capabilityToken.ts`) or a tiny shared `util/`? `host/` — it is a host-level output primitive multiple features depend on, matching `capabilityToken.ts`'s placement.
