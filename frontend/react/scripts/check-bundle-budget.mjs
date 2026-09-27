#!/usr/bin/env node
/**
 * Bundle-budget gate — runs AFTER `vite build`, against `dist/assets/*.js`.
 *
 * The entry chunk is what every user downloads before the app is interactive,
 * so it gets a hard gzip ceiling. CI fails the build if it grows past budget,
 * which forces a deliberate decision (raise the budget, or code-split) rather
 * than letting first-load weight creep up silently (frontend enterprise-review
 * Batch F). A second, looser ceiling guards any single non-entry chunk.
 *
 * Budgets are gzip bytes (what the network actually transfers). Raise them
 * here, in the same PR that justifies the growth.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const ASSETS = 'dist/assets';
// Entry chunk gzip ceiling. After overlay + route lazy-loading the entry is
// ~140 kB gzip; ceiling was 160 kB. Bumped to 164 kB (2026-06-19) to absorb
// accumulated entry growth from intervening main work — the entry crossed
// 160.0 kB on its own. Bumped to 165 kB (2026-06-24) for the shared accessible
// `ui/Menu` primitive (DS-8 — used by the entry-loaded ChatHeader + builder
// toolbar) plus the richer HITL approval cards (gate identity + inline preview);
// the preview's heavy deps (Markdown) stay in their own chunk. Bumped to 167 kB
// (2026-06-24, ADR 0139) for the configurable-nav overlay: the resolver +
// NavConfigProvider + collapse-cookie are unavoidably first-paint (the rails
// render from them); the network client + the editor page are already lazy.
// Bumped to 168 kB (2026-06-25) for accumulated entry growth from two merges:
// the ADR 0138 live-voice mode (a first-paint chat-header control) plus the
// surfacing pass (the ADR 0122 chat Share button + ADR 0124 wiring in the
// entry-loaded ChatHeader/ChatSidebar; the feature pages + sharing client are
// already lazy/code-split). Modest headroom; code-split before raising further.
// Bumped to 169 kB (2026-06-25) for ADR 0140 multi-tab parity (G1–G3): the shared CORE
// submit pipeline (chatSubmit) + the extracted convene/board interceptors
// (conversations/convene.ts) + ConversationLineup are all reached by the entry-loaded
// ChatSidebar (the convene/lineup logic was already INLINE in the entry before the
// extraction — net growth is the shared-module/factory overhead, ~1 kB). The multi-tab
// deck itself stays lazy (ChatTab lazy-imports TabChatDeck).
// Bumped to 172 kB (2026-06-26) for the ADR 0144 Access Hub + ADR 0145's two further
// consoles (Models, Chat-deployment). CORRECTION (2026-06-27): the original note here
// blamed eager-globbed console i18n — that is WRONG. `vite.config` manualChunks already
// routes ALL first-party i18n catalogs into the `i18n` chunk, OFF the entry critical
// path (i18n/resources.ts + the manualChunks function). A sourcemap attribution of the
// entry chunk shows its real weight is: react-dom (~128 kB raw) + react-router (~37 kB)
// — unavoidable framework — plus the eager CHAT shell (`/` is the default route), plus
// stray builder code leaking in via static imports from chat (e.g. WelcomeCard →
// premadeWorkflows for the sync seed, and useChatSession → serialize → palette catalog,
// now lazied). The real lever to reclaim headroom is code-splitting that chat-shell /
// builder-leak surface, NOT i18n. Don't raise this for i18n growth — i18n won't move it.
// Lowered 172 → 170 kB (2026-06-27): lazy-loading the builder serializer out of the chat
// entry (useChatSession run path) dropped it 170.0 → 165.7 kB gzip — reclaim the headroom
// as a guardrail rather than bank the over-bump.
// Bumped 170 → 171 kB (2026-06-27, ADR 0154 Phase 2): channels-in-chat adds irreducible
// EAGER chrome to the chat entry — the rail "+" create affordance + the header
// channel-settings control. All heavy channel code (create/manage dialogs, presence,
// channelsClient) is already lazy-loaded out of the entry; this +1 kB is the always-on
// chrome only.
// Bumped 171 → 172 kB (2026-07-01, ADR 0178 Phase 3): the BYOK soft-warning surfacing
// lives in the always-on chat send path (useChatSession) — an eager, irreducible ~144 B
// (the notice check + warning toast). All the governance-admin UI it pairs with is in the
// lazy connections route, not the entry; this is the chat-side surfacing only.
// Bumped 172 -> 174 kB (2026-07-03): 76 eager nav-catalog keys (labelKey/hintKey
// for 38 sidebar entries x en — LDEBT-7). Nav labels must paint with the shell,
// so they belong in the entry chunk; lazy-loading them would flash English.
// Bumped 174 → 177 kB (2026-07-03, ADR 0192): channels UX parity puts ALWAYS-ON signal
// machinery in the rail + feed — the two-tier unread/mention chips + mute wiring
// (ConversationsRail rows), the shared ui/Avatar + channel attribution branch
// (MessageBubble/MessageFeed), the channel submit/roster hooks, and the ChatHeader
// channel segment (+3 kB, additive with the nav-catalog +2 above). Everything
// channel-CONDITIONAL is lazy (RosterPanel, EmptyState, dialogs, pickers, presence,
// channelsClient via dynamic import); this is the eager, irreducible per-row/
// per-message wiring only.
// Bumped 177 → 178 kB (2026-07-03, ADR 0202): agent-native channel chrome in the
// always-on chat path — the bot badge on agent attribution (MessageBubble), the
// "New messages" divider + summarize control (MessageFeed), the catch-up handler
// (ChatSidebar). ~0.3 kB; the response-policy control + catch-up client stay in
// the lazy channel dialogs / dynamic imports.
// Bumped 178 → 179 kB (2026-07-03, ADRs 0208–0213): the CRM gap-remediation's
// eager-locale i18n growth (~130 crm/csm/email keys × the 2 eager locales)
// landed the entry chunk exactly ON the old ceiling once merged with the
// same-day CMS work. The feature surfaces themselves are lazy chunks.
// Bumped 179 → 180 kB (2026-07-05): the shared `ui/Menu` gained an opt-in `portal`
// mode (positions the dropdown at document.body so it escapes a table's scroll-clip;
// ADR 0083 review M4). Menu is a core entry-chunk component, so the ~0.3 kB of
// positioning logic lands on the entry — which was already at 178.9/179.0 (no
// headroom). Genuine feature growth, not bloat; ~0.8 kB headroom restored.
// Bumped 180 → 183 kB (2026-07-06): accumulated feature-registry growth landing on
// the entry from several merges — the ADR 0272 Sales Territories feature (its page
// is a lazy chunk; only its route manifest is on the entry) plus the merged commerce
// merchandising features (cdp / recommendations / promotions / discovery). Each
// feature's route manifest is entry-resident by design; ~3 kB collective, ~3 kB headroom.
// Bumped 183 → 184 kB (2026-07-09): the entry sat at 183.1/183.0 after the
// conversation-stack remediation (CS-FE-1 memo-stable channel actions +
// CS-FE-6 preference scoping — ~0.3 kB of genuine perf/correctness code on
// the chat entry path, not bloat); ~0.9 kB headroom restored.
// Bumped 184 → 185 kB (2026-07-10): ADR 0327 P2 split useChatSession into the
// chatSession/ hook family — ~0.6 kB of module-boundary overhead (import
// wrappers across 7 files), zero new behavior; the decomposition is the point.
// Bumped 185 → 186 kB (2026-07-10): ADR 0336 Phase 2b — the new commerce-ucp-buyer
// feature's nav manifest + its eager en/pt-BR i18n namespace (ADR 0329 loads
// feature namespaces eagerly for the two eager locales); ~0.2 kB, a real feature.
// Bumped 186 → 188 kB (2026-07-12): the entry sat at a razor edge (185.9/186.0)
// and tipped over from ~150 gzip BYTES of shared-client growth (ADR 0351 P4 —
// kbClient url-ingest fns, the client is also statically imported by a non-lazy
// consumer). Three sessions have now fought this edge; 2 kB of headroom trades
// per-PR byte-chasing for a real check that still catches real regressions.
// Bumped 188 → 190 kB (2026-07-15): the 2 kB above was fully consumed — main
// measured EXACTLY 188.0/188.0, so the next translated string of ANY feature
// tripped the gate (here: XCH-GRP-3's `deepRunBudgetExceeded` toast × 4 eager
// locales, ~0.1 kB). That is the razor edge this comment now describes for the
// FOURTH time. Sizing note for whoever reads this next: the entry is dominated
// by eagerly-loaded i18n namespaces (ADR 0329) — if this needs bumping again,
// the honest fix is lazy per-locale namespace loading or splitting the chat
// namespace, not another +2 kB.
// Bumped 190 → 192 kB (2026-07-17): the per-locale half of the honest fix is
// DONE (ADR 0329 — only `en` is eager; es/fr/pt-BR are lazy chunks), so this
// growth is en-catalog + route-matcher weight from TWO same-day feature
// batches (P0 public platform ADRs 0384/0390/0391 + the docs surface ADR
// 0392), each individually under the old cap. Entry measured 190.4. The next
// structural lever is splitting the chat namespace out of the entry — do that
// before bumping a SIXTH time.
// Bumped 192 → 193 kB (2026-07-17, ADR 0389 P1): MFA enroll/challenge en-catalog
// keys (auth + settings-shell namespaces, both eager) + the AuthCard mfa view.
// Entry measured 192.5. The chat-namespace split above remains the next
// structural lever before any further bump.
// Bumped 193 → 194 kB (2026-07-17, ADR 0402): two new PUBLIC route groups wired
// into the entry router — /book/:slug + /book/manage/:token (booking) and
// /sign/:token (e-sign), i.e. their match*() guards + lazy-page declarations in
// App.tsx (the pages themselves are code-split; only the tiny matchers are eager,
// as with the existing /f/, /fn/, /blog public routes). Entry measured 193.2. The
// chat-namespace split remains the next structural lever before any further bump.
// Bumped 194 → 195 kB (2026-07-18, ADR 0419): the nav-wide "locked feature" lock
// affordance (useFeatureLocked + LockIcon + the store-link override) lands in the
// always-loaded chrome (Sidebar + CommandPalette), which cannot be code-split.
// Entry measured 194.1. The chat-namespace split remains the next structural lever.
// Bumped 198 → 200 kB (2026-07-19, ADR 0434 grade pass): the IDN-3 fix made the
// storage subject OBSERVABLE (tri-state + a listener set in platform/storage.ts,
// which is entry-reachable because every content module imports it) so content
// surfaces can tell the auth boot window apart from settled-anonymous. Part of
// the measured jump is also baseline drift — this branch sits ~40 commits ahead
// of where P3 measured, including concurrent KickTodo merges — so the delta is
// not cleanly attributable to this change alone.
//
// ⚠ STOP BUMPING — SPLIT NEXT. Two raises in one program is the ceiling. The
// entry chunk is dominated by the builder + chat trees; the next feature that
// needs entry headroom should CODE-SPLIT one of those (lazy-load the builder
// canvas, already partially lazy) rather than raise this again. Tracked as
// IDN-10 in docs/steward/CODEBASE-ASSESSMENT.md.
//
// Bumped 196 → 198 kB (2026-07-19, ADR 0434 P3): subject-scoping the four
// `content` localStorage keys added ~1.3 kB gzip to the entry chunk — the
// scoping helpers in platform/storage.ts plus their call sites in chat/,
// builder/, and prompts/, all of which are entry-reachable. The anon→user
// MERGE was already split into a lazy chunk (auth/adoptAnonContent.ts), so
// this residue is the isolation logic itself, which cannot be deferred: it
// runs on every read of user-authored content. Accepted deliberately — the
// alternative is leaving a cross-user content leak on shared browsers.
//
// Bumped 195 → 196 kB (2026-07-19, ADR 0432 P4): the KickTodo H-wave added
// feature pages whose ENGLISH i18n catalogs are `eager: true` by design — `en`
// is the synchronous fallback locale (ADR 0065 `resources.ts:50`), so each new
// feature contributes exactly one catalog to the entry while its es/fr/pt-BR
// siblings stay lazy. The PAGES themselves are all code-split (`lazy(() =>
// import(...))`); this growth is the i18n fallback, not page code. Entry
// measured 194.9 — a deliberate raise per this file's own "raise or code-split"
// contract, not a silent slide. The chat-namespace split remains the next
// structural lever, and lazy-loading non-fallback catalogs is the one after it.
// Bumped 200 → 201 kB (2026-07-24, ADR 0478): the ReviewCard reasoning
// disclosure + two lazy-section wrappers (SLA panel, email opt-in) land ~0.2kB
// on the entry path AFTER code-splitting everything splittable (both new
// sections + their client are lazy chunks). Real entry-path feature surface;
// the split-first discipline held — this is the residue, not avoidance.
//
// ═══ LOWERED 201 → 130 kB (2026-07-28, ENG-4 / IDN-10). The split happened. ═══
//
// The STOP-BUMPING note above was right about the diagnosis and wrong about one
// of the two names: a sourcemap attribution of the entry chunk found the BUILDER
// was already lazy and contributed nothing, while `src/chat/**` was ~197 kB raw —
// 30% of the entry, its largest first-party contributor by 3×. It was there for
// exactly one reason: `chrome/features.tsx` imported `ChatTab` EAGERLY under the
// comment "ChatTab is the home route (`/`) — keep it eager so first paint has no
// lazy flash". That stopped being true when ADR 0375 made the Dashboard the
// always-on home and moved chat to `/chat` (re-confirmed by ADR 0487's `/` gate).
// The import outlived its rationale by ~six weeks; five of the bumps recorded
// above were paid on top of it.
//
// Making ChatTab lazy like every other route: entry 199.9 → 124.8 kB gzip
// (−75.1 kB, −37.6%; raw 654 → 398 kB). Chat becomes ChatTab (~25 kB gz) +
// ChatInput (~19 kB gz) async chunks, prefetched on idle so `/chat` — and every
// legacy `/?agent=` deep link that redirects there — stays warm.
//
// The 130 kB figure is 124.8 measured + ~5 kB (~4%) of deliberate margin. That is
// wider than the 1–2 kB edges that caused six bumps in six weeks and forced this
// note to be rewritten four times, and narrow enough to still catch a real
// regression. What is left is mostly irreducible: react-dom is now 32% of the
// entry, react-router another 9%.
//
// The contract has NOT changed, and it now has a precedent instead of a wish:
// when this is tight, CODE-SPLIT — do not raise it. The next candidates, by
// measured entry weight: `src/chrome` (~35 kB raw, the nav/route manifest),
// `src/notifications` (~16 kB), `src/agents` (~11 kB). Re-measure before
// choosing; the last note guessed and was half wrong.
//
// ═══ 130 → 131 kB (2026-09-05, PracticeMatch ADR 0633 Phase 2). Split first. ═══
// The lane rails needed ONE thing on the entry path: `LaneProvider` (a context
// that must wrap the shell — a lazy provider means a Suspense flash at the root).
// Everything else it brought was split before this note was written: the lane
// menus (`chrome/navConfig/laneMenus.ts`, the largest piece) and the lane client
// are dynamic imports, the three lane homes are lazy route elements. Measured:
// bootstrap 129.5 → 130.5 kB with the provider + three nav entries + four nav
// keys — the same ~1 kB "real entry-path surface after splitting everything
// splittable" residue the 2026-07 notes describe. The next STRUCTURAL lever is
// unchanged and named above: split `src/chrome`'s route manifest; do that before
// any further bump.
// ═══ 131 → 132 kB (2026-09-17, ADR 0726 / ADR 0725). Split first — measured. ═══
// Two seam additions in `client/v2Wire.ts`, both on the entry path by nature
// (every SDK call binds a path parameter; every SDK response is unboxed):
//   - the RFC 0184 `~`-projection of bound path parameters (the Firebase `/api`
//     rewrite decodes `%2F`, which 404'd every personal-workspace run read in
//     production — 41 in three days);
//   - opening the host's `vendor.openwop-app` carry box (RFC 0185 §C) so pages
//     keep reading v1-dialect keys (`initialTurn`, `error.userMessage`, `kind`).
// MEASURED at gzip level 6 against deployed main (`75b80ecb1`): +107 B gzip /
// +456 B min after two compaction passes (a one-expression codec, a single-pass
// unbox); main sat 0 B under the ceiling. Nothing new on the entry path is
// splittable: the seam is imported by the client core every page loads. The
// structural lever is unchanged and still named above — split `src/chrome`'s
// route manifest before any further bump.
// ═══ 132 → 133 kB (2026-09-19). Preserve a meaningful gate after mainline drift. ═══
// The current entry measures 132.1 kB gzip after the latest public-route/chrome
// updates. The CMS-facelift surfaces are lazy chunks (their UI modules do not
// appear in the entry sourcemap), so splitting those pages cannot reclaim initial
// bytes. One kilobyte restores deliberate, sub-1k headroom without masking a
// material bootstrap regression.
//
// ═══ CORRECTION, same day (#4034): REVERTED to 132. A split DID exist. ═══
// The note above is right that the CMS-facelift pages are lazy and cannot reclaim
// entry bytes — I verified that independently. But the entry did not grow only
// from those pages. `features/{profiles,media}` were importing a 12-line
// FileReader helper from `chat/hooks/useAudioRecorder.ts`, dragging that whole
// 207-line MediaRecorder hook onto the entry via
// chrome/Sidebar -> PinnedAgentsNav -> profilesClient.
//
// `client/blobToBase64.ts` ALREADY EXISTED to fix exactly this, and its docblock
// claimed "The hook re-exports it" — it did not, and both feature clients still
// imported the hook. The split had been performed, documented as complete, and
// silently regressed. Finishing it MEASURED 132.1 kB -> 131.3 kB gzip, so 132
// holds with headroom and the raise is no longer load-bearing.
//
// Restoring it because this ledger's own contract (below) is "when this is tight,
// CODE-SPLIT — do not raise it", and every prior raise cited evidence that the
// growth was irreducible. That evidence was unavailable here only because the
// regressed split was invisible: a docblock asserting adoption that never happened.
const ENTRY_GZIP_BUDGET = 132 * 1024;

/**
 * WARN BAND. Above this fraction of a budget the check still PASSES but says so loudly.
 *
 * This exists because of where the breach actually lands. Hosted CI is disabled, so
 * `npm run ci` green on YOUR BRANCH is the merge gate — and the gate measures the branch,
 * never the merge result. Two PRs each a few hundred bytes under individually merge to
 * over, and the red lands on `main`, paid for by every session except the two that caused
 * it. MEASURED 2026-09-19: the 132 kB ceiling was set on 2026-09-17 with ~917 B of
 * headroom and was exhausted in two days across 18 commits; nobody saw it coming because
 * a passing run printed only the size, never the remaining room.
 *
 * So the fix is not a looser threshold — softening the cliff just moves it. It is making
 * the last kilobyte VISIBLE to the PR that consumes it, pre-merge. Deliberately NOT
 * hysteresis on the failing threshold, and deliberately NOT a per-PR delta check instead
 * of the absolute cap: a pure delta gate lets a few hundred bytes per PR ratchet upward
 * forever, which is the creep this file exists to stop.
 */
const WARN_AT = 0.98;
const warned = [];
// Any single non-entry chunk gzip ceiling.
// Bumped 260 → 264 kB (2026-07-03): the same-day gap-remediation i18n growth —
// CMS page-experiments (ADR 0236), strategy/campaign, and the ecommerce commerce
// + storefront + productGrid-editor catalogs across 4 locales — pushed the LAZY
// `i18n` chunk (off the entry critical path) just past the old ceiling once merged.
// Bumped 264 → 266 kB (2026-07-03, grade-ux campaign pass): the a11y/UX-fix
// keys (platform labels, dispatch-list, cpaNotApplicable, experiment error/reason,
// brief validation/toasts) across 4 locales added the final ~0.6 kB.
// The strategy follow-on batch (2026-07-03) then added the scenario-builder,
// score-history, and InfoTip-label catalogs (priority-matrix + strategy keys ×
// 4 locales) to the same LAZY `i18n` chunk (~0.1 kB) — stays within 266 kB.
// Bumped 266 → 268 kB (2026-07-04, ecommerce-deferral Phase 3, ADR 0240): the
// productGrid store/product-picker + product-attribute editor + refund/tax/currency
// keys × 4 locales pushed the LAZY `i18n` chunk ~0.1 kB past 266.
// Bumped 268 → 269 kB (2026-07-04, ADR 0256): the email authored-body editor's
// format-toggle + preview keys (editorFormatLabel/formatPlain/markdownHint/
// previewLabel/previewError × 4 locales) added ~0.1 kB to the same LAZY `i18n`
// chunk (off the entry critical path).
// Bumped 269 → 271 kB (2026-07-04, ecommerce-deferral follow-on Group C, ADR 0257):
// the typed product custom-field manager + typed-value editor keys × 4 locales added ~0.5 kB
// to the same LAZY `i18n` chunk, on top of the email growth above.
// Bumped 271 → 274 kB (2026-07-05, commerce merchandising program, ADR 0271/0273–0277):
// the `recommendations` namespace × 4 locales added ~0.3 kB to the LAZY `i18n` chunk;
// headroom reserved for the sibling promotions/discovery namespaces (MERCH-B/C).
// Bumped 274 → 276 kB (2026-07-05, CDP program, ADR 0263/0266/0267): the `cdp`
// namespace + campaign-orchestration journey keys × 4 locales added ~0.3 kB to the
// same LAZY `i18n` chunk (off the entry critical path); rounded up for headroom.
// Bumped 276 → 280 kB (2026-07-06, sales-org i18n, ADR 0280/0281/0282): externalizing
// the sales-commissions/dealers/sales-maps pages adds three new namespaces × 4 locales
// to the LAZY `i18n` chunk (~2 kB across the 3 pages, measured at landing); headroom to 282.
// Bumped 282 → 285 kB (2026-07-06, funnels i18n, ADR 0294 P5): the 4-locale
// `funnels` catalog adds ~1.8 kB gzip to the i18n chunk (measured 283.8 at
// landing); headroom to 285.
// Bumped 285 → 287 kB (2026-07-06, funnels routing-editor + daily-trend i18n,
// FNL-UX-2/4): ~0.2 kB gzip of new rule/trend keys ×4 locales (measured 285.1).
// Bumped 287 → 289 kB (2026-07-06, ADR 0305 Phase B): app-builder editor
// interaction-core keys (undo/redo, arrange, screen CRUD ×4 locales) added
// ~0.4 kB gzip to the LAZY `i18n` chunk (measured 287.4); headroom to 289.
// Bumped 289 → 291 kB (2026-07-07, ADR 0305 Phases D+E): app-builder preview/
// share/device keys + version-history keys ×4 locales (~0.7 kB gzip, measured
// 289.3); headroom to 291.
// (ADR 0304 speakingLabel ×4 locales rides within the 291 headroom — ~0.1 kB gzip.)
// Bumped 291 → 292 kB (2026-07-07, ADR 0130 Phase 6): model-router
// conversationKind condition keys ×4 locales (~0.1 kB gzip, measured 291.1 —
// main already sat at the ceiling).
// Bumped 292 → 293 kB (2026-07-07, ADR 0310 Phase B): the slides-editor type
// catalog (~28 contract keys × 4 locales) + 1 chat key pushed the LAZY `i18n`
// chunk ~0.1 kB past 292.
// Bumped 293 → 294 kB (2026-07-07, ADR 0310 Phase C): three new type catalogs
// (drawings/cad/campaign-studio, ~53 contract keys × 4 locales) + 2 canvas +
// 1 chat key added ~0.5 kB to the same LAZY `i18n` chunk.
// Bumped 294 → 295 kB (2026-07-07, ADR 0313 D3): heartbeat-silence chips +
// bare-card autonomy hints + won't-fire schedule chips (kanban + schedules
// namespaces ×4 locales, ~0.2 kB gzip; measured 294.2 at landing).
// Bumped 295 → 296 kB (2026-07-07, ADR 0314): the creation-gallery vocabulary
// (~10 canvas type_* + ~20 documents keys × 4 locales, ~0.5 kB gzip) lands on
// top of the same-day ADR 0313 growth in the same LAZY `i18n` chunk.
// Bumped 296 → 297 kB (2026-07-07, ADR 0316): the new `canvases` namespace
// (~30 browser/dialog keys × 4 locales) + the picker-search keys, ~0.5 kB in
// the same LAZY `i18n` chunk.
// Bumped 297 → 298 kB (2026-07-07, ADR 0318): the 4-locale `heartbeat` admin-settings
// strings (settings namespace) + 2 nav keys × 4 locales — real multi-locale copy in
// the same LAZY `i18n` chunk, not an entry-critical code-split target.
// Bumped 298 → 299 kB (2026-07-09, grade pass): graph keyboard-model +
// template/favorites strings across 4 locales tipped the i18n chunk.
// Also 2026-07-09 (ADR 0079/0058 routing corrections): the strategy +
// priority-matrix detail-page keys (net +1 / +4 keys × 4 locales) land in the
// same LAZY `i18n` chunk under the same 299 kB ceiling.
// Bumped 299 → 300 kB (2026-07-10, ADR 0328 P0+1): slides export + version-
// compare strings across 4 locales.
// Bumped 299 → 300 kB (2026-07-09, DESIGN.md rule-13 sweep): localized
// stage_*/status_* chip vocabularies (crm/email/cms/publishing × 4 locales)
// — real multi-locale copy in the same LAZY `i18n` chunk.
// Bumped 300 → 303 kB (2026-07-10): the new `territories` namespace (~150
// keys × 4 locales) — the LAST zero-i18n feature page converted; check-i18n's
// hardcoded-string counter reached 0 with this change.
// Bumped 303 → 304 kB (2026-07-10): the same-day ADR 0328 slides keys merged
// beside the territories namespace and landed the LAZY i18n chunk at 303.3.
// Lowered 304 → 210 kB (2026-07-10, ADR 0329 per-locale i18n chunks): the
// eager i18n chunk now carries ONLY `en` + the i18next libs (~162 kB gzip);
// every other locale is its own lazy `i18n-<locale>` chunk (~140 kB each,
// loaded only when negotiated/selected). The ceiling now guards the real
// largest chunk (markdown, ~201 kB gzip) instead of an ever-growing
// all-locales bundle — locale copy growth no longer moves this number.
// Bumped 210 → 213 kB (2026-07-19): the KickTodo experience phases (ADR
// 0436/0437/0438 — participant polish + creator studio workspace/insights +
// the additive admin-trust tier A0/A2/A3/A7) added their eager `en` UI strings
// to this chunk, landing it at ~210.2 kB. Real feature copy, not a regression;
// every KickTodo surface itself is a lazy route chunk. Non-`en` locales remain
// their own lazy `i18n-<locale>` chunks, unaffected.
// Bumped 213 → 214 kB (2026-07-20, ADR 0448 P2): the sharing mint-once UX
// copy (hashed-at-rest tokens) added ~5 keys ×4 locales; the chunk was already
// at the cliff, so any key tripped it. Deliberate bump per this gate's rule.
// Bumped 214 → 216 kB (2026-07-21, ADR 0458 §2.3): the new `challenge-outline`
// canvas type's eager `en` catalog — the chassis type-vocabulary contract
// (editorHeading/docName/frame words) + renderer/widget strings + served-prop
// localization (~78 keys) landed the chunk at 215.0 kB. Real feature copy for a
// new canvas type (the slides/drawings/cad type-catalog precedent above); the
// outline editor itself is a lazy route chunk. Non-`en` locales are unaffected
// (their own lazy `i18n-<locale>` chunks). 216 gives ~1 kB headroom.
// Bumped 216 → 218 kB (2026-07-21, ADR 0461 P2): the Studio's embedded
// Challenge Author welcome — 17 keys ×2 eager locales (en + pt-BR: welcome
// copy, example intents, the workflow-portfolio labels) landed the chunk at
// exactly 216.0 kB. Real feature copy per this gate's rule; 218 restores the
// ~2 kB headroom the 0458 bump had left.
// Bumped 218 → 220 kB (2026-07-22, ADR 0442 Guide wave): the SAME pattern for
// the Guide's embedded KickBot welcome — ~18 keys × the eager locales (welcome
// copy, coaching example intents, contextual seeds) tipped the chunk to 218.1 kB.
// Real feature copy; 220 restores ~2 kB headroom.
// Bumped 220 → 222 kB (2026-07-23, ADR 0473 grade-hardening): the composed-
// workflow review card + builder proposal banner copy — ~40 keys × 4 locales
// (review verbs, role badges, degraded/expired notices, localized risk levels)
// landed the chunk at exactly 220.0 kB. Real feature copy; 222 restores the
// ~2 kB headroom.
// Bumped 222 → 224 kB (2026-07-23, ADR 0476): the fleet-insights + debug-loop
// copy across four locales (stats chips/tooltips, heatmap, estimates, redrive
// outcomes — ~60 keys × 4 locales in this program) landed the i18n chunk at
// 222.1 kB. Real localized feature copy, same pattern as the 220→222 bump.
// Bumped 224 → 225 kB (2026-07-24, ADR 0479): the environments per-domain
// diff honesty copy (apply-only labels + rewritten danger-confirm ×4 locales)
// tipped the combined i18n chunk 0.1 kB over. Copy that stops a false claim
// on the most dangerous confirm is worth 1 kB of budget.
// Bumped 225 → 227 kB (2026-07-24, ADR 0482): per-node cost + budget copy —
// ~35 keys × 4 locales (cost heatmap mode, budget dialog/chip with the
// "includes debug/eval spend" disclosures, per-node cost table notes) landed
// the i18n chunk at 225.7 kB. Real localized feature copy, the 0476 pattern.
// Bumped 227 → 232 kB (2026-07-24, UX_UPGRADE-* program): the seven merged
// public-surface UX upgrades (site/docs/forms/funnels/crm-public/sharing/
// podcasts) added ~85 user-facing keys × 4 locales — blog filter + reading time,
// docs filter/breadcrumb/pager, form help text + error summary, funnel progress
// + retry, booking time-zone switcher + per-field errors, share snapshot notice,
// podcast explicit label + episode pager. This is real product copy, not bloat,
// and it crossed the ceiling cumulatively (each PR passed on its own). Recorded
// rather than silently raised: the NEXT bump should code-split the locale bundle
// per namespace instead, because this chunk is now the largest non-vendor asset.
// LOWERED 236 → 150 kB (2026-07-25, ADR 0490 — the split the two notes above
// kept deferring is DONE, so this ratchet ratchets DOWN instead of up).
// `en` FEATURE catalogs no longer sit in the eager chunk; each rides the lazy
// page that needs it. Measured with THIS script's method (gzip of the built
// file): 233.0 → 124.3 kB, a 47% cut, with ~25 kB of headroom left deliberately
// so the next feature pass does not have to touch this line at all.
//
// Read the number THIS script prints, not the one `vite build` prints — they
// disagree by ~5 kB on the same file (vite reported 238.3 where this measured
// 233.0), and acting on vite's number is how the last two raises happened.
//
// If this needs raising again, the honest options are (a) another namespace
// leaves the eager set — check `SHELL_FEATURE_NAMESPACES` in
// `src/i18n/resources.ts` for something that no longer renders in the shell, or
// (b) the shell copy itself genuinely grew. It is NOT for feature copy: feature
// copy no longer lands here.
const CHUNK_GZIP_BUDGET = 150 * 1024;

// Per-chunk overrides for legitimately-heavy VENDORED libs that are code-split
// into their own LAZY chunk (loaded on demand, cached independently). KaTeX
// (ADR 0334 2b-2) bundles ~227 kB gzip with all its font-metric data — it is
// shared by the chat markdown renderer AND the canvas.document math node, split
// out of the markdown chunk so it neither bloats markdown nor duplicates.
//
// ADR 0490 added three LAZY LOCALE overrides (~225–232 kB) and named the `en`
// namespace split as the obvious next step. That step is now DONE, so the three
// overrides are DELETED rather than lowered: pt-BR/fr/es measure 95.5 / 98.8 /
// 96.8 kB and clear the 150 kB global ceiling on their own. An override that is
// no longer needed is removed — naming a chunk below the ceiling only buys
// silence. This is the first time this file has shrunk its exception list.
//
// The locale chunks keep ADR 0329's one-request property for everything the
// SHELL needs; only feature catalogs were deferred, and they ride the same lazy
// boundary their pages already use.
//
// The global ceiling is set at 150 kB — above the two heaviest LEGITIMATE
// feature chunks (`documentSchema` 146.3, `wardley` 141.9, both lazy and both
// fetched only by the one surface that needs them) so they need no override,
// and 25 kB above the post-split eager i18n chunk. Naming a chunk below only
// buys silence, so the list stays short on purpose.
const PER_CHUNK_GZIP_BUDGET = {
  katex: 235 * 1024,
};

let files;
try {
  files = readdirSync(ASSETS).filter((f) => f.endsWith('.js') && !f.endsWith('.map'));
} catch {
  console.error(`check-bundle-budget: ${ASSETS} not found — run \`vite build\` first.`);
  process.exit(1);
}

function gzipBytes(path) {
  return gzipSync(readFileSync(path)).length;
}

const kib = (n) => `${(n / 1024).toFixed(1)} kB`;
let failed = false;

// Every budget in this file was measured against the DEFAULT build. A named
// distribution excludes features, and excluding a chunk's CO-TENANTS removes the
// other importers of their shared deps — so Rollup stops hoisting that code into
// a common chunk and inlines it here instead. MEASURED 2026-08-28:
// `DocumentEditorPage` is 27.2 kB gzip in the default build and 172.6 kB in the
// `kicktodo` build. Same source, 6.3x, in the SMALLER distribution.
//
// So a breach here under OPENWOP_DISTRIBUTION is not evidence of a size problem,
// and the two reflex fixes are both wrong: raising the ceiling blinds the default
// build it was tuned for, and code-splitting targets a chunk that is already small
// there. Say so at the point of failure — a doc is only read by someone who already
// suspects, and nothing in the bare message would make you suspect.
const DISTRIBUTION = process.env.OPENWOP_DISTRIBUTION ?? 'default';
const isNamedDistribution = DISTRIBUTION !== 'default';

for (const f of files) {
  const path = join(ASSETS, f);
  const raw = statSync(path).size;
  const gz = gzipBytes(path);
  const isEntry = f.startsWith('index-');
  const override = Object.entries(PER_CHUNK_GZIP_BUDGET).find(([name]) => f.startsWith(`${name}-`))?.[1];
  const budget = isEntry ? ENTRY_GZIP_BUDGET : (override ?? CHUNK_GZIP_BUDGET);
  if (gz > budget) {
    failed = true;
    console.error(
      `✗ check-bundle-budget: ${f} is ${kib(gz)} gzip (${kib(raw)} min) — over the ` +
      `${isEntry ? 'ENTRY' : 'chunk'} budget of ${kib(budget)} by ${gz - budget} B. ` +
      `Code-split or raise the budget in scripts/check-bundle-budget.mjs.`,
    );
  } else if (gz > budget * WARN_AT) {
    warned.push(`${f}: ${kib(gz)} gzip, ${budget - gz} B under the ${isEntry ? 'ENTRY' : 'chunk'} budget of ${kib(budget)}`);
  }
}

if (warned.length) {
  console.warn(`\n⚠ check-bundle-budget: within ${Math.round((1 - WARN_AT) * 100)}% of budget — the next small addition breaks MAIN, not your branch:`);
  for (const w of warned) console.warn(`    ${w}`);
  console.warn('  Split something now, while it is cheap and attributable to one PR.\n');
}

if (failed) {
  if (isNamedDistribution) {
    console.error(
      `\nNOTE: this is the '${DISTRIBUTION}' distribution, and these budgets are calibrated\n`
      + `against the DEFAULT build. Excluding features can make an individual chunk LARGER\n`
      + `(lost co-tenant dependency sharing), so a breach here may be a composition artifact\n`
      + `rather than a size regression. Build the default distribution and measure the same\n`
      + `chunk before acting — if it passes there, do NOT raise the budget and do NOT\n`
      + `code-split; ask whether the feature belongs in this distribution at all.\n`
      + `See DEPLOY.md § "White-label distributions".`,
    );
  }
  process.exit(1);
}

const entry = files.find((f) => f.startsWith('index-'));
if (entry) {
  const gz = gzipBytes(join(ASSETS, entry));
  // Print the HEADROOM, not just the size. The burn rate is what a reader needs, and
  // reconstructing it from historical logs is archaeology nobody does.
  console.log(`✓ check-bundle-budget: entry chunk ${kib(gz)} gzip (budget ${kib(ENTRY_GZIP_BUDGET)}, ${ENTRY_GZIP_BUDGET - gz} B of headroom).`);
} else {
  console.log('✓ check-bundle-budget: no entry chunk matched index-*.js (skipped).');
}
