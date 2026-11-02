/**
 * The SPA's circles client calls the prefix the backend actually mounts.
 *
 * THE DEFECT THIS PINS (2026-10-30). `/circles` showed "Could not load your
 * circles" for every user in production. The backend mounts the accountability
 * routes under `KICKTODO_CIRCLES_PREFIX` (`/host/openwop-app/kicktodo/circles`),
 * but both SPA clients called `/host/openwop-app/circles`, which nothing serves
 * (404; zero 200s on that path in 30 days of prod logs). 548c41f79 (2026-09-11)
 * moved the participant PAGE from `/kicktodo/circles` to `/circles`, and the
 * same rename rewrote the two API base URLs with it. Its other eight page
 * renames touched no API URL.
 *
 * It survived because the one frontend test that looked at the URL
 * (`CirclesCreateIdempotency.test.tsx`) pinned the wrong path, and nothing
 * compared the client base with the mount.
 *
 * Red when (witnessed against the pre-fix tree): the SPA constant differs from
 * the backend prefix; a second SPA file spells a circles API base as its own
 * literal instead of importing the constant; the constant is renamed or moved.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { KICKTODO_CIRCLES_PREFIX } from '../src/features/kicktodo-accountability/routes.js';
import { stripComments } from './helpers/stripComments.js';

const FE_SRC = resolve(process.cwd(), '..', '..', 'frontend', 'react', 'src');
const CLIENT = join(FE_SRC, 'client', 'kicktodoCirclesClient.ts');


function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('KickTodo circles: the SPA client base is the backend mount', () => {
  it('the exported client path equals KICKTODO_CIRCLES_PREFIX', () => {
    const code = stripComments(readFileSync(CLIENT, 'utf8'));
    const m = /export const KICKTODO_CIRCLES_PATH\s*=\s*'([^']+)'/.exec(code);
    expect(m, 'kicktodoCirclesClient.ts must export KICKTODO_CIRCLES_PATH as a string literal').not.toBeNull();
    expect(m![1]).toBe(KICKTODO_CIRCLES_PREFIX);
  });

  it('no other SPA source file spells a circles API base itself', () => {
    const files = sourceFiles(FE_SRC);
    // Denominator floor: a wrong root would scan nothing and pass.
    expect(files.length).toBeGreaterThan(500);
    const offenders = files
      .filter((f) => f !== CLIENT)
      .filter((f) => /host\/openwop-app\/(kicktodo\/)?circles\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(FE_SRC, f));
    expect(offenders, 'import KICKTODO_CIRCLES_PATH from client/kicktodoCirclesClient.ts instead').toEqual([]);
  });
});
