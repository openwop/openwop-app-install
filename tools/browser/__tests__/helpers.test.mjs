/**
 * tools/browser/helpers.mjs tests.
 *
 * Pure logic — no Playwright needed. Each test covers one decision
 * branch in the server-side command handlers so regressions surface
 * without having to spin up the browser integration harness.
 *
 * Why: `resolveEvalFilePath` is the sandbox on `evalFile` (server.mjs
 * cmdEvalFile, BROWSER-TOOL.md), which reads a file and runs it in the page.
 * Not in `npm run ci`: nothing in the gate reds this file.
 *
 * Sabotage that turns it red (each probed): dropping `path.resolve` (an absolute
 * path with `..` escapes), dropping `path.sep` from a prefix (a sibling directory
 * passes), the allowlist itself. `pattern.length >= 3` is an equivalent mutant: an
 * empty inner has no metacharacter and yields the same substring.
 *
 * Uses Node's built-in test runner so the repo root needs no test framework
 * dependency (openwop-app keeps the root manifest lean — each workspace owns
 * its own deps). Run with a QUOTED glob so Node expands it, not the shell:
 *
 *     node --test 'tools/browser/__tests__/*.test.mjs'
 *
 * The bare-directory form (`node --test tools/browser/`) does NOT work on
 * Node 22 — it resolves the path as a module and exits 1 having run nothing,
 * which reads like one failing test rather than a whole suite skipped.
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
    // A sibling that shares the prefix is still outside.
    assert.throws(() => resolveEvalFilePath('/Users/test/repo-evil/x.js', projectRoot), /must be under PROJECT_ROOT or \/tmp/);
    assert.throws(() => resolveEvalFilePath('/tmpevil/x.js', projectRoot), /must be under PROJECT_ROOT or \/tmp/);
  });

  it('rejects path-traversal escapes that resolve outside the sandbox', () => {
    assert.throws(() => resolveEvalFilePath('../../../../etc/passwd', projectRoot), /must be under PROJECT_ROOT or \/tmp/);
    // path.join already normalises the relative form; these need path.resolve.
    assert.throws(() => resolveEvalFilePath('/tmp/../etc/passwd', projectRoot), /must be under PROJECT_ROOT or \/tmp/);
    assert.throws(() => resolveEvalFilePath('/Users/test/repo/../../../etc/passwd', projectRoot), /must be under PROJECT_ROOT or \/tmp/);
  });

  it('rejects empty path', () => {
    assert.throws(() => resolveEvalFilePath('', projectRoot), /non-empty string/);
  });
});
