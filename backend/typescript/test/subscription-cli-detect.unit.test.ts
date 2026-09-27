/**
 * ADR 0182 Phase 1 — read-only vendor-CLI login detection + its effect on the
 * honest-off `subscription` advertisement.
 *
 * Detection is exercised against real temp-dir fixtures (pointed at via the
 * CLIs' own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` overrides) so nothing touches the
 * developer's actual `~/.claude` / `~/.codex`. All paths are side-effect-free
 * and must never throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  subscriptionLoginDetected,
  subscriptionRequireDetectedLogin,
} from '../src/aiProviders/subscriptionCliDetect.js';
import { subscriptionAdvertisedProviders } from '../src/aiProviders/aiProvidersHost.js';

let claudeDir: string;
let codexDir: string;

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'OPENWOP_SUBSCRIPTION_AT_OWN_RISK',
  'OPENWOP_SUBSCRIPTION_PROVIDERS',
  'OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  claudeDir = mkdtempSync(join(tmpdir(), 'owp-claude-'));
  codexDir = mkdtempSync(join(tmpdir(), 'owp-codex-'));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(codexDir, { recursive: true, force: true });
});

function writeClaude(obj: unknown): void {
  writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify(obj), 'utf8');
}
function writeClaudeRaw(raw: string): void {
  writeFileSync(join(claudeDir, '.credentials.json'), raw, 'utf8');
}
function writeCodex(obj: unknown): void {
  writeFileSync(join(codexDir, 'auth.json'), JSON.stringify(obj), 'utf8');
}

describe('subscriptionLoginDetected — Claude (anthropic) is never detected (ADR 0756)', () => {
  // Anthropic's terms prohibit third-party routing through Claude consumer plans,
  // so even a valid, renewable Claude Code login is never a reason to advertise.
  it('returns false for a valid renewable Claude login', () => {
    writeClaude({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1 } });
    expect(subscriptionLoginDetected('anthropic')).toBe(false);
  });

  it('returns false (no throw) on malformed JSON', () => {
    writeClaudeRaw('{ not json');
    expect(subscriptionLoginDetected('anthropic')).toBe(false);
  });
});

describe('subscriptionLoginDetected — Codex (openai)', () => {
  it('detects API-key auth', () => {
    writeCodex({ OPENAI_API_KEY: 'sk-abc' });
    expect(subscriptionLoginDetected('openai')).toBe(true);
  });

  it('detects a personal access token', () => {
    writeCodex({ personal_access_token: 'pat-abc' });
    expect(subscriptionLoginDetected('openai')).toBe(true);
  });

  it('detects ChatGPT/OAuth auth (tokens.refresh_token)', () => {
    writeCodex({ tokens: { access_token: 'exp', refresh_token: 'rt' } });
    expect(subscriptionLoginDetected('openai')).toBe(true);
  });

  it('rejects an empty auth.json', () => {
    writeCodex({});
    expect(subscriptionLoginDetected('openai')).toBe(false);
  });

  it('returns false when the auth file is absent', () => {
    expect(subscriptionLoginDetected('openai')).toBe(false);
  });
});

describe('subscriptionLoginDetected — unknown provider', () => {
  it('returns false for a provider with no consumer-subscription CLI', () => {
    expect(subscriptionLoginDetected('google')).toBe(false);
    expect(subscriptionLoginDetected('mistral')).toBe(false);
  });
});

describe('subscriptionRequireDetectedLogin gate', () => {
  it('is off unless explicitly enabled', () => {
    expect(subscriptionRequireDetectedLogin()).toBe(false);
    process.env.OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN = 'true';
    expect(subscriptionRequireDetectedLogin()).toBe(true);
  });
});

describe('subscriptionAdvertisedProviders — detection AND-clause (advertisement only)', () => {
  it('with REQUIRE_LOGIN off: advertises exactly the ADR 0180 operator-gated set (deterministic, no detection)', () => {
    process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK = 'true';
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'openai';
    // No login fixtures written — proves the default path does NOT read the home dir.
    expect(subscriptionAdvertisedProviders()).toEqual(['openai']);
  });

  it('with REQUIRE_LOGIN on: narrows to providers with a detected login', () => {
    process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK = 'true';
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'openai,mistral';
    process.env.OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN = 'true';
    // Only Codex is logged in; mistral has no detectable CLI login.
    writeCodex({ OPENAI_API_KEY: 'sk-abc' });
    expect(subscriptionAdvertisedProviders()).toEqual(['openai']);
  });

  it('with REQUIRE_LOGIN on and NO login: stays dark', () => {
    process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK = 'true';
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'openai';
    process.env.OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN = 'true';
    expect(subscriptionAdvertisedProviders()).toEqual([]);
  });

  it('stays dark when the operator has not opted in at all', () => {
    // Neither ADR 0180 flag set — the base gate keeps it dark regardless.
    expect(subscriptionAdvertisedProviders()).toEqual([]);
  });
});
