/**
 * ADR 0873 D3 — the ONE service-worker registration URL and scope.
 *
 * A browser keeps one registration per scope, and `register()` with a different
 * script URL at the same scope replaces that registration's worker. Two call
 * sites with two URLs would reinstall the worker on every boot and every push
 * enable. Every `register()`/`getRegistration()` imports these; nothing else
 * spells the URL (the permanent `public/sw-push.js` shim is the one exception,
 * pinned to this value by `scripts/__tests__/serviceWorker.test.ts`).
 */
export const SW_URL = '/sw.js';
export const SW_SCOPE = '/';
