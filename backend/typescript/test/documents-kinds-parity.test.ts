/**
 * DOCT-5 — the FE kind list is a HAND-COPY of the backend SSoT, and it drifted:
 * the backend shipped 8 seeded kinds, the SPA's copy had 7, and since that copy
 * IS the Kind <select> in NewDocumentModal, `board-update` documents were
 * uncreatable from the UI and nothing noticed. The promptCatalogParity pattern:
 * pin the copy to its source so the NEXT kind added cannot silently vanish
 * from the picker.
 *
 * The FE literal is parsed out of the source text (the access-header-parity
 * precedent) rather than imported — the backend build must not take a
 * dependency on the SPA workspace.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEEDED_KINDS } from '../src/features/documents/documentsService.js';

const FE_CLIENT = join(process.cwd(), '../../frontend/react/src/features/documents/documentsClient.ts');

describe('DOCT-5 — FE SEEDED_KINDS mirrors the backend SSoT', () => {
  it('the two lists are IDENTICAL, in order', () => {
    const src = readFileSync(FE_CLIENT, 'utf8');
    const m = /export const SEEDED_KINDS = \[([^\]]+)\] as const;/.exec(src);
    expect(m, 'documentsClient.ts no longer declares SEEDED_KINDS — update this gate with the new spelling').toBeTruthy();
    const feKinds = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(feKinds, 'FE copy drifted from documentsService.SEEDED_KINDS — a kind missing on the FE side is uncreatable from the SPA').toEqual([...SEEDED_KINDS]);
    // Anti-vacuity floor: an empty parse must not equal an empty source list.
    expect(feKinds.length).toBeGreaterThanOrEqual(8);
  });
});
