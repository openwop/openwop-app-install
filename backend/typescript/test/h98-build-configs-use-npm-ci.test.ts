/**
 * H98 — `scripts/check-build-installs.mjs`, the zero gate that keeps build
 * configs on `npm ci`.
 *
 * WHY THE GATE EXISTS: npm >= 11.5 prunes the transitive deps of an
 * optionalDependency during `npm install`, which in this repo leaves the Azure
 * Key Vault KMS backend present-but-unloadable. The root Dockerfile was moved to
 * `npm ci` in #2680/#2696. `deploy/compose/frontend.Dockerfile` was not, and
 * stayed on `npm install` for months because nothing looked.
 *
 * WHY THESE TESTS EXIST: the gate's own failure mode is silence. A walk whose
 * patterns stop matching prints a clean scan of nothing and exits 0 — output
 * indistinguishable from a healthy repo. So the cases below exercise BOTH arms:
 * the finding arm (does it see a real `RUN npm install`?) and the
 * REQUIRED-floor arm (does it refuse to pass when it scanned nothing?). Each
 * negative case is paired with the positive that proves it could have failed.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs repo script, no types
import { scan, REQUIRED } from '../../../scripts/check-build-installs.mjs';

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'owp-h98-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe('check-build-installs — the real repo', () => {
  it('is clean: no build config runs `npm install`', () => {
    const { findings } = scan();
    expect(findings).toEqual([]);
  });

  it('actually READ the build configs — a clean scan of nothing must not pass', () => {
    const { files, missing } = scan();
    // The floor the gate reports on. If this ever shrinks silently, the "clean"
    // result above means nothing.
    expect(missing).toEqual([]);
    for (const req of REQUIRED) expect(files).toContain(req);
    expect(files.length).toBeGreaterThanOrEqual(REQUIRED.length);
  });
});

describe('check-build-installs — the finding arm', () => {
  it('flags `RUN npm install` in a Dockerfile, with the right line', () => {
    const root = tree({
      Dockerfile: 'FROM node:22-slim\nWORKDIR /app\nRUN npm install --include=dev\n',
    });
    try {
      const { findings } = scan({ root, required: ['Dockerfile'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ file: 'Dockerfile', line: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags it in a compose/CI yaml run block too, not only Dockerfiles', () => {
    const root = tree({
      '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - run: npm install\n',
      Dockerfile: 'FROM node:22-slim\nRUN npm ci\n',
    });
    try {
      const { findings } = scan({ root, required: ['Dockerfile'] });
      expect(findings.map((f: { file: string }) => f.file)).toEqual(['.github/workflows/ci.yml']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a comment — the root Dockerfile quotes the forbidden command repeatedly', () => {
    const root = tree({
      Dockerfile: '# `npm ci`, NOT `npm install` — see #2680.\nFROM node:22-slim\nRUN npm ci\n',
    });
    try {
      const { findings } = scan({ root, required: ['Dockerfile'] });
      expect(findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag `npm install -g` — that installs a tool, not the dep closure', () => {
    const root = tree({
      Dockerfile: 'FROM node:22-slim\nRUN npm install -g corepack\nRUN npm ci\n',
    });
    try {
      const { findings } = scan({ root, required: ['Dockerfile'] });
      expect(findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check-build-installs — the REQUIRED-floor arm', () => {
  /**
   * The arm most likely to rot. Without it, renaming a build config turns the
   * gate into a no-op that still prints a tick.
   */
  it('reports a required config that was never scanned', () => {
    const root = tree({ Dockerfile: 'FROM node:22-slim\nRUN npm ci\n' });
    try {
      const { findings, missing } = scan({
        root,
        required: ['Dockerfile', 'deploy/compose/frontend.Dockerfile'],
      });
      expect(findings).toEqual([]); // nothing wrong with what it DID read...
      expect(missing).toEqual(['deploy/compose/frontend.Dockerfile']); // ...but it did not read enough
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an EMPTY tree reports every required path missing, not a clean pass', () => {
    const root = tree({ 'README.md': 'not a build config\n' });
    try {
      const { files, findings, missing } = scan({ root, required: [...REQUIRED] });
      expect(files).toEqual([]);
      expect(findings).toEqual([]);
      expect(missing).toEqual([...REQUIRED]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
