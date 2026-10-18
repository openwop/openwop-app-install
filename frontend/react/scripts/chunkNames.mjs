/**
 * ADR 0874 D2 — which built chunks keep a readable name, and which become `c-[hash].js`.
 *
 * WHY. Every lazy page puts its chunk's hashed filename into the entry's preload table
 * (`"assets/CompanyDetailPage-DTmBjwPF.js"`). The hashes barely compress, and the
 * readable prefix only lengthens each one. MEASURED 2026-10-11 on 942d52c10: hash-only
 * names for async chunks take the entry from 130.9 to 127.1 kB gzip, at no runtime cost.
 *
 * WHAT KEEPS ITS NAME. Only chunks that something keys on BY NAME:
 *   - the `manualChunks` outputs in vite.config.ts (`i18n`, `i18n-<locale>`,
 *     `firebase`, `katex`, `markdown`);
 *   - every `PER_CHUNK_GZIP_BUDGET` key in check-bundle-budget.mjs, which matches
 *     overrides by `<name>-` prefix (that script imports this list and fails if a
 *     budget key is missing from it, so the two cannot drift).
 * The entry is not a `chunkFileNames` chunk at all: it stays `index-[hash].js` via
 * `entryFileNames`, which verify-deploy.sh, write-build-info.mjs and the budget
 * script all depend on.
 *
 * Sourcemaps still name every source file, so debugging loses only the URL prefix.
 */

/** Chunk names that keep `[name]-[hash].js`. */
export const NAMED_CHUNKS = Object.freeze(['i18n', 'firebase', 'katex', 'markdown']);

/** Lazy locale chunks are named `i18n-<locale>` by manualChunks (ADR 0329). */
const LAZY_LOCALE_CHUNK = /^i18n-(pt-BR|fr|es)$/;

/** True when the chunk named `name` must keep its readable name. */
export function keepsReadableName(name) {
  return NAMED_CHUNKS.includes(name) || LAZY_LOCALE_CHUNK.test(name);
}

/** Rollup `output.chunkFileNames` function (vite.config.ts). */
export function chunkFileName(chunkInfo) {
  return keepsReadableName(chunkInfo.name) ? 'assets/[name]-[hash].js' : 'assets/c-[hash].js';
}
