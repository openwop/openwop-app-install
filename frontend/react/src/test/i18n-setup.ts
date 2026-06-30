/**
 * Vitest setup (ADR 0065) — bootstraps the i18n framework before any test
 * renders. Component tests use `useTranslation(...)` / `t(...)`; without an
 * initialized i18next instance those calls return raw keys instead of the
 * English copy, so assertions on visible text would break. Importing the
 * bootstrap for its side effect registers every catalog (core + per-feature)
 * via `import.meta.glob`, exactly as the app does at runtime.
 */
import '../i18n/index.js';
