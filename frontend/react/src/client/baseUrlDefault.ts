/**
 * Single source of truth for the dev-only fallback backend origin.
 *
 * This exact value is baked into the bundle ONLY when no
 * `VITE_OPENWOP_BASE_URL` is supplied at build time — a dev convenience.
 * Two consumers depend on it agreeing:
 *
 *   1. `src/client/config.ts` uses it as the runtime dev fallback.
 *   2. The production-build guard in `vite.config.ts` REJECTS this exact
 *      value so the dev fallback can never reach a shipped bundle.
 *
 * If these two drifted apart (e.g. the fallback changed here but the guard
 * still checked the old literal), the guard would silently stop protecting
 * against the default leaking into a production build. Keep both importing
 * this constant — never re-hardcode the literal.
 *
 * This module is intentionally dependency-free (no `import.meta.env`) so it
 * is safe to import from `vite.config.ts`, which is evaluated in Node where
 * `import.meta.env` is undefined.
 */
export const DEV_FALLBACK_BASE_URL = 'http://localhost:8080';
