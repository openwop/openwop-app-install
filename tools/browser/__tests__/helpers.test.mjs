/**
 * tools/browser/helpers.mjs tests.
 *
 * Pure logic — no Playwright needed. Each test covers one decision
 * branch in the server-side command handlers so regressions surface
 * without having to spin up the browser integration harness.
 *
 * Uses Node's built-in test runner (`node --test tools/browser/`) so the repo
 * root needs no test framework dependency (openwop-app keeps the root manifest
 * lean — each workspace owns its own deps).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseWaitUrlPattern, urlMatchesPattern, resolveEvalFilePath } from '../helpers.mjs';

describe('parseWaitUrlPattern', () => {
  it('treats a plain string as a substring match', () => {
    assert.deepStrictEqual(parseWaitUrlPattern('/dashboard/'), { kind: 'substring', value: '/dashboard/' });
  });

  it('compiles /foo/ as a regex', () => {
    const parsed = parseWaitUrlPattern('/^app-builder/');
    assert.strictEqual(parsed.kind, 'regex');
    assert.ok(parsed.value instanceof RegExp);
    assert.strictEqual(parsed.value.source, '^app-builder');
  });

  it('throws a descriptive error on invalid regex', () => {
    assert.throws(() => parseWaitUrlPattern('/(/'), /Invalid regex in waitUrl/);
  });

  it('throws on empty pattern', () => {
    assert.throws(() => parseWaitUrlPattern(''), /non-empty string/);
  });

  it('handles a one-char slash "/" as a substring (too short to be a regex)', () => {
    assert.strictEqual(parseWaitUrlPattern('/').kind, 'substring');
  });
});

describe('urlMatchesPattern', () => {
  it('substring match hits when the URL contains the pattern', () => {
    const parsed = parseWaitUrlPattern('/dashboard/app-builder/');
    assert.strictEqual(urlMatchesPattern('http://localhost:5173/dashboard/app-builder/surf', parsed), true);
    assert.strictEqual(urlMatchesPattern('http://localhost:5173/settings', parsed), false);
  });

  it('regex match hits when the compiled regex does', () => {
    const parsed = parseWaitUrlPattern('/dashboard\\/[a-z-]+$/');
    assert.strictEqual(urlMatchesPattern('http://localhost:5173/dashboard/app-builder', parsed), true);
    assert.strictEqual(urlMatchesPattern('http://localhost:5173/dashboard/app-builder/surf', parsed), false);
  });
});

describe('resolveEvalFilePath', () => {
  const projectRoot = '/Users/test/repo';

  it('resolves relative paths under projectRoot', () => {
    assert.strictEqual(resolveEvalFilePath('tools/foo.js', projectRoot), path.join(projectRoot, 'tools/foo.js'));
  });

  it('accepts absolute paths under projectRoot', () => {
    assert.strictEqual(resolveEvalFilePath('/Users/test/repo/tools/foo.js', projectRoot), '/Users/test/repo/tools/foo.js');
  });

  it('accepts /tmp paths', () => {
    assert.strictEqual(resolveEvalFilePath('/tmp/foo.js', projectRoot), '/tmp/foo.js');
  });

  it('accepts /private/tmp paths (macOS symlink target)', () => {
    assert.strictEqual(resolveEvalFilePath('/private/tmp/foo.js', projectRoot), '/private/tmp/foo.js');
  });

  it('rejects paths outside projectRoot and /tmp', () => {
    assert.throws(() => resolveEvalFilePath('/etc/passwd', projectRoot), /must be under PROJECT_ROOT or \/tmp/);
  });

  it('rejects path-traversal escapes that resolve outside the sandbox', () => {
    assert.throws(() => resolveEvalFilePath('../../../../etc/passwd', projectRoot), /must be under PROJECT_ROOT or \/tmp/);
  });

  it('rejects empty path', () => {
    assert.throws(() => resolveEvalFilePath('', projectRoot), /non-empty string/);
  });
});
