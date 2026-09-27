/**
 * M2 — a raw i18n key reached the user, twice: in the mic chip's `title` AND in
 * its `sr-only` span. `ChatInput` composed ``t(`voiceCtxBlock_${b}`)`` from a
 * backend-supplied ledger value, so a voice session on a boardroom whose planning
 * context failed announced *"Voice is running with reduced context:
 * voiceCtxBlock_board_context"*. `check-i18n.mjs` cannot see a dynamically
 * composed key, which is why the build stayed green.
 *
 * Two arms, and they prove DIFFERENT things:
 *   1. the FALLBACK — an unknown ledger value resolves to the generic key, never
 *      to an identifier. This is the part that holds for the NEXT value the
 *      backend adds, which no catalog test can anticipate;
 *   2. CATALOG PARITY — every value the helper claims to cover really does have a
 *      string in all four shipped locales, read from the real catalogs (no `t`
 *      mock, so a missing key cannot be papered over by an echoing stub).
 */
import { describe, expect, it } from 'vitest';
import { VOICE_CTX_BLOCKS, voiceCtxBlockKey, voiceCtxBlockLabels } from '../voiceCtxLabels.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const CATALOGS: Array<[string, Record<string, unknown>]> = [
  ['en', en as unknown as Record<string, unknown>],
  ['es', es as unknown as Record<string, unknown>],
  ['fr', fr as unknown as Record<string, unknown>],
  ['pt-BR', ptBR as unknown as Record<string, unknown>],
];

describe('M2 — the voice degradation-ledger label lookup', () => {
  it('falls back to the generic key for a ledger value it does not know', () => {
    expect(voiceCtxBlockKey('some_future_block')).toBe('voiceCtxBlock_other');
    expect(voiceCtxBlockKey('')).toBe('voiceCtxBlock_other');
    // …and the composed chip text carries no raw identifier. `t` echoes its key
    // here, which is the WORST case for this assertion: if the fallback were
    // removed, the identifier would appear verbatim.
    const echo = (k: string): string => k;
    expect(voiceCtxBlockLabels(echo, ['board_context', 'some_future_block']))
      .toBe('voiceCtxBlock_board_context, voiceCtxBlock_other');
    expect(voiceCtxBlockLabels(echo, ['some_future_block'])).not.toContain('some_future_block');
  });

  it('still resolves a KNOWN value to its own key (the fallback is not a blanket)', () => {
    // Anti-rot: `() => 'voiceCtxBlock_other'` would pass the arm above while
    // making every block label identical and the disclosure useless.
    for (const block of VOICE_CTX_BLOCKS) {
      expect(voiceCtxBlockKey(block)).toBe(`voiceCtxBlock_${block}`);
    }
  });

  it('every covered ledger value has a real string in all four locales', () => {
    for (const [locale, catalog] of CATALOGS) {
      for (const block of [...VOICE_CTX_BLOCKS, 'other']) {
        const key = `voiceCtxBlock_${block}`;
        const value = catalog[key];
        expect(typeof value, `${locale} is missing "${key}"`).toBe('string');
        expect((value as string).length, `${locale}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("covers every block name the backend's degradation ledger can push", () => {
    // The backend and the SPA are separate deploy artifacts, so this list cannot
    // be a compile-time link — it is a hand-kept mirror of the `degraded.push(...)`
    // sites in `host/chatContext.ts` + `features/voice/realtime/routes.ts`. Pinned
    // here so ADDING a backend block without a string is a visible diff on this
    // file rather than a raw key in a screen reader. (The fallback above is what
    // makes forgetting it survivable; this is what makes it noticeable.)
    expect([...VOICE_CTX_BLOCKS].sort()).toEqual([
      'agent_knowledge', 'board_context', 'board_context_partial', 'identity',
      'owner_knowledge', 'persona', 'preamble', 'twin_borrowed_recall',
      // RCL-UX-2 — the twin partial-failure case now reaches the ledger
      // (`host/chatContext.ts` pushes it when a borrowed source leg faults but
      // chunks still composed; board_context_partial precedent).
      'twin_borrowed_recall_partial', 'whole',
    ]);
  });
});
