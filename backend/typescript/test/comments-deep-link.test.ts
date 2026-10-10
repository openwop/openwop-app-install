/**
 * CMNT-1 — the two halves of the notification deep-link round trip, pinned on the
 * BACKEND side.
 *
 * The frontend half lives in
 * `frontend/react/src/features/comments/__tests__/commentsDeepLink.test.tsx`,
 * which drives a real `actionUrl` through `CommentsPage` into `CommentsPanel` for
 * all six types. That test can only be trusted if the URL it builds is the URL
 * this emitter actually writes, and if the frontend's `ResourceType` union is the
 * one this service registers — those are the two things pinned here.
 *
 * Why both: the shipped defect was a FRONTEND coercion, but it was ABLE to ship
 * because the frontend union carried four members while the backend registered
 * six, and nothing anywhere compared them. A drift test on one side only would
 * have stayed green through it.
 *
 * SABOTAGE (witnessed): building the URL by string concatenation (no encoding) reds
 * every per-type case; dropping a type from the frontend literal reds the drift case.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESOURCE_TYPES } from '../src/features/comments/commentsService.js';
import { threadActionUrl } from '../src/features/comments/notifications.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLIENT = join(REPO, 'frontend/react/src/features/comments/commentsClient.ts');

describe('CMNT-1 — threadActionUrl carries the real type and id, for every commentable type', () => {
  for (const rt of RESOURCE_TYPES) {
    it(`${rt}: the link names the resource, never a coerced stand-in`, () => {
      const url = threadActionUrl({ orgId: 'org_1', resourceType: rt, resourceId: 'res#1' });
      // Parse it the way a BROWSER does. `new URLSearchParams(url.slice(…))` treats a raw
      // `#` as a literal character, so an unencoded id read back intact and the encoding
      // claim below could not fail (/grade-tests wave 10: the probe that dropped the
      // encoding stayed green). `URL` splits the fragment off, exactly as navigation does.
      const parsed = new URL(url, 'https://app.example');
      expect(parsed.pathname).toBe('/comments');
      expect(parsed.hash, 'a `#` in any value must be percent-encoded, never start a fragment').toBe('');
      const q = parsed.searchParams;
      expect(q.get('orgId')).toBe('org_1');
      expect(q.get('resourceType')).toBe(rt);
      expect(q.get('resourceId')).toBe('res#1'); // the `#` MUST be encoded, not truncated
    });
  }
});

describe('CMNT-1 — the frontend ResourceType union matches the backend set', () => {
  it('ALL_RESOURCE_TYPES in commentsClient.ts is exactly RESOURCE_TYPES', () => {
    const src = readFileSync(CLIENT, 'utf8');
    const m = /export const ALL_RESOURCE_TYPES: readonly ResourceType\[\] = \[([^\]]*)\]/.exec(src);
    // A pattern that no longer matches means the frontend declaration was
    // renamed or reshaped — that is a FAILURE, not a pass. Silently matching
    // nothing is how a drift gate becomes decorative.
    expect(m, 'ALL_RESOURCE_TYPES literal not found in commentsClient.ts — this gate is inert, fix the pattern').toBeTruthy();
    const fe = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
    expect(fe.length, 'parsed an EMPTY frontend list — the gate would pass vacuously').toBeGreaterThan(0);
    expect([...fe].sort()).toEqual([...RESOURCE_TYPES].sort());
  });
});
