// ADR 0182 — shim-side detection (file-only, never-throws). Fixtures via
// CLAUDE_CONFIG_DIR / CODEX_HOME temp dirs; never touches the real home.
// ADR 0756 is the tripwire here: anthropic and google are refused even with a
// valid login present. Under-advertise, never over-advertise: an unusable file
// reads as absent. Not in `npm run ci`: run `npm test` in clients/subscription-provider.
//
// Sabotage that turns it red (each probed): a provider that reaches a login (the
// prohibited ones hold a real Codex credential, so a re-route shows), each
// credential field alone, the non-empty rule, a corrupt file throwing.

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
  codex({ OPENAI_API_KEY: 'sk' });
  assert.equal(subscriptionLoginDetected('openai'), true); // the fixture does hold a usable login
  assert.equal(subscriptionLoginDetected('anthropic'), false);
});

test('codex: api key detected', () => {
  codex({ OPENAI_API_KEY: 'sk' });
  assert.equal(subscriptionLoginDetected('openai'), true);
  codex({ personal_access_token: 'pat' });
  assert.equal(subscriptionLoginDetected('openai'), true);
});

test('codex: chatgpt tokens detected', () => {
  codex({ tokens: { refresh_token: 'rt' } });
  assert.equal(subscriptionLoginDetected('openai'), true);
  codex({ tokens: { access_token: 'at' } });
  assert.equal(subscriptionLoginDetected('openai'), true);
});

test('codex: missing or corrupt auth.json reads as no login, never a throw', () => {
  assert.equal(subscriptionLoginDetected('openai'), false); // no file yet
  writeFileSync(join(codexDir, 'auth.json'), '{ not json');
  assert.equal(subscriptionLoginDetected('openai'), false);
  writeFileSync(join(codexDir, 'auth.json'), 'null');
  assert.equal(subscriptionLoginDetected('openai'), false);
});

test('codex: empty credential values read as no login', () => {
  for (const auth of [{ OPENAI_API_KEY: '' }, { OPENAI_API_KEY: '   ' }, { personal_access_token: 7 }, { tokens: {} }, { tokens: { access_token: ' ', refresh_token: '' } }]) {
    codex(auth);
    assert.equal(subscriptionLoginDetected('openai'), false, JSON.stringify(auth));
  }
});

test('unknown provider → false', () => {
  codex({ OPENAI_API_KEY: 'sk' });
  assert.equal(subscriptionLoginDetected('openai'), true); // the fixture does hold a usable login
  assert.equal(subscriptionLoginDetected('google'), false);
});
