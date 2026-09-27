// ADR 0182 — shim-side detection (file-only, never-throws). Fixtures via
// CLAUDE_CONFIG_DIR / CODEX_HOME temp dirs; never touches the real home.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscriptionLoginDetected } from '../src/detect.js';

let claudeDir, codexDir, savedClaude, savedCodex;

beforeEach(() => {
  savedClaude = process.env.CLAUDE_CONFIG_DIR;
  savedCodex = process.env.CODEX_HOME;
  claudeDir = mkdtempSync(join(tmpdir(), 'shim-claude-'));
  codexDir = mkdtempSync(join(tmpdir(), 'shim-codex-'));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
});

afterEach(() => {
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  if (savedCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodex;
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(codexDir, { recursive: true, force: true });
});

const claude = (o) => writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify(o));
const codex = (o) => writeFileSync(join(codexDir, 'auth.json'), JSON.stringify(o));

test('ADR 0756 — a valid Claude login is never detected (anthropic prohibited)', () => {
  claude({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } });
  assert.equal(subscriptionLoginDetected('anthropic'), false);
});

test('codex: api key detected', () => {
  codex({ OPENAI_API_KEY: 'sk' });
  assert.equal(subscriptionLoginDetected('openai'), true);
});

test('codex: chatgpt tokens detected', () => {
  codex({ tokens: { refresh_token: 'rt' } });
  assert.equal(subscriptionLoginDetected('openai'), true);
});

test('unknown provider → false', () => {
  assert.equal(subscriptionLoginDetected('google'), false);
});
