# ADR 0413 — Native-rendered participant client (Expo/React Native)

Status: **Accepted** — 2026-07-18. The shared-contract decision is in effect (the React-free `kicktodoClient.ts` layer shipped with ADR 0414 C5 as the contract material; the host surface it rides is complete). P1's device-gated legs (Expo scaffold, the OQ10 real-device OIDC spike) and P2–P5 are **blocked on operator resources** (devices, push credentials, store accounts) — deliberately NOT simulated headless, per this ADR's own spike-not-assumed rule.

**Supersedes:** ADR 0181 **partially** — for the **participant** client only. ADR 0181's desktop Electron shell and the web PWA remain; the iOS `WKWebView` shell becomes a transition/host-compatibility harness retired only after RN reaches release parity with a tested install-migration path.
**Consumed by:** ADR 0414 (`kicktodo-core`) — the participant surfaces (Today, enrollment, check-in, progress, KickBot conversation) are the first native screens.
**Surface:** a NEW non-normative **client** surface. **NO new RFC** — it rides the already-published REST+SSE host surface and the already-accepted bearer-token auth path.

## Why this exists

The KickTodo PRD (§9.6) requires a first-class iOS+Android participant app. ADR 0181 deliberately shipped **zero native UI** ("one SPA everywhere / no second UI that drifts", `0181:57`) via WebView shells. A consumer habit product needs native UX, offline, push, and store presence that a WebView cannot deliver well. This ADR **owns that reversal honestly** rather than letting it happen implicitly — the KickTodo PRD review (finding H1) required it be recorded as a superseding decision.

## Boundaries audit (Step 3 — verified against live code)

**The reusable, React-free layer genuinely exists** (the good news):
- Published SDK `@openwop/openwop` — `OpenwopClient`, `streamEvents`, error/envelope/type surface; raw `fetch`, framework-agnostic, npm-consumable by RN.
- ~40 `frontend/react/src/client/*Client.ts` modules are **React-free** (grep for `react`/`useState` in `src/client/*Client.ts` → zero hits), funnelling through one `requestJson.ts` + one `config.ts` auth/credentials chokepoint.
- Auth is **already token-capable**: `config.ts:142-143` gives a Firebase **`Bearer` ID token precedence over cookies**; the backend accepts bearer-then-cookie (`config.ts:120-126`).
- SSE **already abandoned `EventSource`** for `fetch`+`ReadableStream` (`streamsClient.ts:106-124,262`) — more RN-portable than `EventSource`.

**The genuine gaps** (net-new, not a port):
- **The entire view layer.** `frontend/react/src` outside `src/client/` is React-DOM: `ui/` (44 dirs), xyflow, TipTap, Mermaid, KaTeX, `@dnd-kit`, `react-router`. **None renders in RN.** ADR 0181 explicitly rejected a native-rendered UI (`0181:57`).
- Production default is **cookie mode** (`.env.production`, `VITE_OPENWOP_AUTH_MODE=cookie`) — no browser cookie jar on native → must run **token-first** + native Firebase sign-in (web uses `signInWithRedirect`, `firebase.ts:246-270`).
- **Native push is unbuilt** — today it's Web Push/VAPID + `sw-push.js`; the iOS shell README lists "APNs push out of scope" → needs APNs/FCM.
- RN `fetch` needs a **streaming polyfill** for the `ReadableStream` SSE path (or fall back to the run-event long-poll with `Last-Event-ID`).
- **App-store signing/notarization pipeline** does not exist (iOS shell is unsigned/simulator-only).
- (`react-native` greps in the repo are the **app-builder code-export target** for end-users' *built* apps — not OpenWOP itself being RN.)

## Decision

Ship a first-class **Expo** participant app under `clients/mobile/` (Expo Router, RN New Architecture, Hermes), and extract the shared, renderer-neutral packages that make "share contracts, not screens" real:

- `kicktodo-contracts` (no React) — generated wire + host-ext types, artifact schemas, error vocabulary, route constants, idempotency-key builders.
- `kicktodo-client` — the `*Client.ts`/SDK layer with **injected** auth/fetch/stream/locale/telemetry adapters (strip `import.meta.env`; only 2 files touch it today).
- `kicktodo-domain` — pure projections/validators/permission-predicates/reducers.
- `kicktodo-design-tokens` — semantic tokens/typography/spacing/motion-intent generated from the distribution source; **separate** React-DOM and RN component implementations.

**Drift-control gates (the two-UI-surface contract):** the shared packages are the single source of behavior; one canonical route-intent vocabulary (`today|challenge|enrollment|check-in|conversation|approval`) with web-Router and Expo-Router mappers; platform code via `.native.ts`/`.ios.ts`/`.android.ts`, never runtime conditionals in domain modules; **do not port** DOM-heavy editor/canvas/TipTap/Mermaid/XYFlow surfaces — creator/operator work stays web-first.

## Phased plan (mirrors PRD §9.6.5)

| Phase | Ships |
|---|---|
| **P1 Foundation** | `clients/mobile` scaffold, the four shared packages, distribution-generated native config, **token-first OIDC bearer spike on real devices**, API smoke, read-only Today on both platforms. |
| **P2 Closed alpha** | Enrollment, Today actions, check-in, progress, named-KickBot conversation/profile, universal links, foreground/background refresh, **native push registration + Expo receipt processing**, crash/trace instrumentation. |
| **P3 Offline/recovery** | Bounded cache/outbox (SQLite; SQLCipher if sensitive), conflict UI, media-upload recovery, timezone/DST + accessibility passes. |
| **P4 Store launch** | Commerce entitlement/checkout handoff, production signing, privacy manifests, staged rollout, upgrade/rollback gates, iOS-shell migration. |
| **P5 Native advantage** | Widgets, haptics, camera/evidence capture, calendar/wearable — each gated on consent/data-ownership/battery/replay rules. |

**Host-side deltas (no wire change):** extend the existing **Notifications** owner with native-device registrations (store deliverable token as protected secret + hash fingerprint; **do not** create `kicktodo-push`); add a **host-private** minimum-supported-build handshake (not an OpenWOP capability). Backend deploys before mobile clients that consume new behavior.

## Alternatives weighed

- **Keep ADR 0181 WebView-only** — rejected: cannot deliver consumer-grade native UX/offline/push; the whole KickTodo thesis is a mobile habit product.
- **Separate native product with its own backend/Firebase** (PRD §16 option A) — rejected: duplicates identity/storage/schedules/notifications/payments/replay; two truths forever.
- **Full supersession of 0181 (retire desktop + web too)** — rejected: the creator/operator workbench and the desktop self-host story stay web/Electron; only the participant client goes native.

## Open questions (PRD §18 Q10–Q12)

1. Native identity: the configured provider's native SDK vs a system-browser authorization-code/PKCE flow? **Settle by a real-device spike, not from web Firebase behavior.**
2. Push: existing Expo delivery adapter vs direct APNs/FCM? (Recommend Expo first behind a transport boundary that preserves a direct-provider migration.)
3. Minimum-supported-build window + the adoption threshold that permits retiring the transitional Swift shell / a host-extension field.

## RFC verdict

**Host work — no new RFC.** The client rides `/.well-known/openwop`, `/v1/runs`, SSE, and the accepted bearer-auth path; it advertises nothing on the wire. The 0181 supersession is a host/client architecture decision, recorded here.

## Implementation record

**Externally BLOCKED — device/store/push-gated (per the Status line).** The Expo
scaffold, the real-device OIDC/PKCE spike (OQ10/Q1), native push send (APNs/FCM),
the shared-package extraction's *consumer*, and the store signing/notarization
pipeline all require operator resources this environment cannot provide (physical
iOS/Android devices, Apple/Google Developer accounts, APNs/FCM credentials, store
listings) — and this ADR's **spike-not-assumed rule forbids simulating them
headless**. They are not started; forcing untestable/simulated device work would
violate the ADR + the repo's honesty invariants.

**Host-side delta SHIPPED (2026-07-18) — the one testable, non-device slice:**
- **Minimum-supported-build handshake** — `GET /v1/host/openwop-app/client-support?build=&platform=`
  (`backend/typescript/src/routes/clientSupport.ts`). The host publishes the
  operator-configured build FLOOR (`OPENWOP_MIN_CLIENT_BUILD[_IOS|_ANDROID|_WEB]`,
  default 0 = no-op) + an optional upgrade URL; the client **self-gates** (no
  enforcement middleware — a mis-set floor must never lock users out). An UNKNOWN
  build is never gated. Non-normative host-ext (no RFC), public + unauthenticated
  (a client checks it before it has a session; discloses only a chosen build
  number). Serves the eventual native client AND the existing web/PWA (force-upgrade
  a stale cached SPA on backend skew — a real hazard, see DEPLOY.md). Tests:
  `test/client-support.test.ts` (default no-op, per-platform floor override,
  below-floor→unsupported+upgradeUrl, unknown-build-not-gated, header + query parse).

**Deferred host delta (not built):** native-device push-token registration on the
Notifications owner — it cannot be exercised end-to-end without APNs/FCM credentials
+ a registering device (both blocked), and the Notifications/KickTodo surfaces are
under active parallel development (ADRs 0414/0419/0420), so it is left to the phase
that has the push credentials + a client to register, avoiding speculative infra +
collisions.
