/**
 * The app's release version — the single RUNTIME source of truth (ADR 0052 §D4).
 *
 * Kept in lockstep with the repo-root `/VERSION` file and the `version` field of
 * `backend/typescript/package.json` + `frontend/react/package.json` by the
 * `/cut-app-release` skill. Do NOT hand-edit out of band — bump it through a
 * release so the bundle, the `/readiness` version, the recorded `__app_meta`
 * `app_version`, and the published `vX.Y.Z` artifact all agree.
 */
export const APP_VERSION = '0.1.0';
