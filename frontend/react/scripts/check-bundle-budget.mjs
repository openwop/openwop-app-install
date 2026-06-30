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
const ENTRY_GZIP_BUDGET = 171 * 1024;
// Any single non-entry chunk gzip ceiling.
const CHUNK_GZIP_BUDGET = 260 * 1024;

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

for (const f of files) {
  const path = join(ASSETS, f);
  const raw = statSync(path).size;
  const gz = gzipBytes(path);
  const isEntry = f.startsWith('index-');
  const budget = isEntry ? ENTRY_GZIP_BUDGET : CHUNK_GZIP_BUDGET;
  if (gz > budget) {
    failed = true;
    console.error(
      `✗ check-bundle-budget: ${f} is ${kib(gz)} gzip (${kib(raw)} min) — over the ` +
      `${isEntry ? 'ENTRY' : 'chunk'} budget of ${kib(budget)}. Code-split or raise the budget in scripts/check-bundle-budget.mjs.`,
    );
  }
}

if (failed) process.exit(1);

const entry = files.find((f) => f.startsWith('index-'));
if (entry) {
  console.log(`✓ check-bundle-budget: entry chunk ${kib(gzipBytes(join(ASSETS, entry)))} gzip (budget ${kib(ENTRY_GZIP_BUDGET)}).`);
} else {
  console.log('✓ check-bundle-budget: no entry chunk matched index-*.js (skipped).');
}
