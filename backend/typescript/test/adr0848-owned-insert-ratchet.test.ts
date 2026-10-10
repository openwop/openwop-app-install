/**
 * ADR 0848 — the structural half of the D1 ratchet (the behavioural half is
 * `adr0848-email-integrity.test.ts`).
 *
 * #4485 survived ADR 0838 because the documents fix was a PRIVATE copy: the email
 * stores, keyed by id alone in exactly the same way, never got one. This pins:
 *  1. one owner of the rule — `host/ownedInsert.ts` — and both adopters calling it;
 *  2. no blind `put` on the two email stores anywhere in `emailService.ts`: every write
 *     is the shared insert or a `compareAndSwap` (a blind read-then-put after a delete
 *     resurrected the row — architect review M6);
 *  3. no second private "owned or conflict" helper growing back.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('ADR 0848 D1 — one id-owner rule, and the email stores never write blind', () => {
  it('both adopters create through insertOwnedOrConflict', () => {
    expect(read('features/email/emailService.ts')).toMatch(/insertOwnedOrConflict\(templates,/);
    expect(read('features/email/emailService.ts')).toMatch(/insertOwnedOrConflict\(campaigns,/);
    expect(read('features/documents/documentsService.ts')).toMatch(/insertOwnedOrConflict\(docs,/);
  });

  it('emailService never calls a blind put on email:template / email:campaign', () => {
    expect(read('features/email/emailService.ts')).not.toMatch(/\b(templates|campaigns)\.put\(/);
  });

  it('the two email collections are declared only in emailService (no second writer module)', () => {
    const declaring = walk(SRC).filter((f) => /new DurableCollection<[^>]*>\('email:(template|campaign)'/.test(readFileSync(f, 'utf8')));
    expect(declaring.map((f) => f.slice(SRC.length + 1))).toEqual(['features/email/emailService.ts']);
  });

  it('no private "owned or conflict" helper grows back beside the shared one', () => {
    const copies = walk(SRC)
      .filter((f) => !f.endsWith('host/ownedInsert.ts'))
      .filter((f) => /async function ownedOrConflict\b/.test(readFileSync(f, 'utf8')));
    expect(copies).toEqual([]);
  });
});
