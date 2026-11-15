/**
 * ADR 1122 P0 — a refused session on an asset read continues ANONYMOUS
 * (`middleware/auth.ts` `passAnonymous`), so none of its identity may reach the
 * serve route's decision. That holds only while `passAnonymous` deletes every
 * identity field the middleware assigns. A field added to the middleware later
 * would ride through on a refused session, so this reads the source: every
 * `req.<field> =` assignment in `auth.ts` must be deleted in `passAnonymous`.
 * Sabotage: remove one `delete req.…` line and this fails, naming the field.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'src/middleware/auth.ts'), 'utf8');

describe('ADR 1122 — passAnonymous strips every identity field auth.ts sets', () => {
  it('each `req.<field> =` assigned in the middleware is deleted on the anonymous fall-through', () => {
    const assigned = new Set([...src.matchAll(/\breq\.([A-Za-z]+)\s*=(?!=)/g)].map((m) => m[1] ?? ''));
    const start = src.indexOf('function passAnonymous(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body.length).toBeGreaterThan(100);
    const deleted = new Set([...body.matchAll(/delete req\.([A-Za-z]+);/g)].map((m) => m[1] ?? ''));
    const missing = [...assigned].filter((f) => !deleted.has(f));
    expect(missing, 'set by auth.ts but not stripped by passAnonymous').toEqual([]);
    expect(assigned.size).toBeGreaterThanOrEqual(6);
  });
});
