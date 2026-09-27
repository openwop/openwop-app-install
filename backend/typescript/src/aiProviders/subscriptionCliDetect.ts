/**
 * ADR 0182 Phase 1 — read-only detection of a logged-in vendor coding-agent CLI.
 *
 * Purpose: feed the RFC 0121 / ADR 0180 honest-off `subscription` advertisement
 * so that — when an operator opts in via `OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN` —
 * the host advertises `subscription` for a provider ONLY when a usable local CLI
 * login is actually present. This is the readiness half of the self-hosted
 * subscription-CLI executor; the dispatch shim itself lives OUTSIDE this repo
 * (the backend stays provider-agnostic and MUST NOT spawn a vendor CLI).
 *
 * Boundary (ADR 0182): this module is **file-read-only** — it parses the vendor
 * CLIs' own credential files and NEVER spawns a process (no `claude auth status`,
 * no `codex login status`). It therefore honors the "no vendor-CLI spawn in
 * backend/typescript/src" gate. Under-advertising, never over-advertising: an
 * unreadable or absent file keeps the host DARK. (ADR 0756: only the Codex login
 * is detected; the Claude Code branch was removed with Anthropic's prohibition.)
 *
 * It reads NO token material into openwop — it only asks whether a credential is
 * *present and plausibly usable*. Token custody stays entirely with the vendor
 * CLI. Every failure path (missing file, unreadable, malformed JSON, wrong
 * shape) resolves to `false`; the functions never throw and never touch the
 * network.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Codex's home — honors its own `CODEX_HOME` override (default `~/.codex`). */
function codexAuthPath(): string {
  const base = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(base, 'auth.json');
}

/** Read + JSON-parse a file to a plain object, or `null` on any failure. */
function readJsonObject(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // missing / unreadable
  }
  try {
    const data: unknown = JSON.parse(raw);
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null; // malformed
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Whether Codex's `~/.codex/auth.json` carries a usable credential — either
 * API-key auth (`OPENAI_API_KEY` / `personal_access_token`) or ChatGPT/OAuth
 * auth (a `tokens` object holding `access_token` / `refresh_token`).
 * Presence-based by design: Codex refreshes short-lived tokens itself, so this
 * asks only whether a credential is configured, not whether it would authorize.
 */
function codexLoginDetected(): boolean {
  const data = readJsonObject(codexAuthPath());
  if (data === null) return false;
  if (nonEmptyString(data['OPENAI_API_KEY']) || nonEmptyString(data['personal_access_token'])) {
    return true;
  }
  const tokens = data['tokens'];
  if (typeof tokens === 'object' && tokens !== null) {
    const t = tokens as Record<string, unknown>;
    if (nonEmptyString(t['access_token']) || nonEmptyString(t['refresh_token'])) return true;
  }
  return false;
}

/**
 * Read-only, side-effect-free, never-throws: whether a usable local vendor-CLI
 * login exists for the given RFC 0121 provider id. `openai` maps to the Codex
 * login; any other provider returns `false`. ADR 0756 removed the Claude Code
 * branch: Anthropic's terms prohibit third-party routing through Claude
 * consumer plans, so no Claude login is ever a reason to advertise.
 */
export function subscriptionLoginDetected(provider: string): boolean {
  switch (provider) {
    case 'openai':
      return codexLoginDetected();
    default:
      return false;
  }
}

/**
 * ADR 0182 Phase 1 operator opt-in. When `OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN` is
 * `true`, the honest-off `subscription` advertisement is additionally narrowed
 * to providers with a detected local login (see `subscriptionAdvertisedProviders`
 * in aiProvidersHost). OFF by default so the ADR 0180 operator contract — and its
 * deterministic discovery tests — are unchanged: advertisement then depends only
 * on the two ADR 0180 flags, not on the CI host's home directory.
 */
export function subscriptionRequireDetectedLogin(): boolean {
  return process.env.OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN === 'true';
}
