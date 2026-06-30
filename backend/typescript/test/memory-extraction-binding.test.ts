/**
 * ADR 0120 Phase 2b — extraction binding (real consent gate + real note store).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { setExtractionGrant } from '../src/features/memory-auto-extract/grantService.js';
import { extractConversationMemory } from '../src/features/memory-auto-extract/extractionBinding.js';
import { countSubjectNotes } from '../src/host/subjectMemory.js';
import { personSubject } from '../src/host/subject.js';

const T = 'mxb-tenant';
beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-mxb-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('extractConversationMemory', () => {
  it('FAIL-CLOSED: no grant ⇒ no LLM call, no note stored', async () => {
    const extract = vi.fn(async () => ['the user prefers dark mode']);
    const r = await extractConversationMemory(T, 'nogrant-user', 'chat', extract);
    expect(r.skipped).toBe('no-consent');
    expect(extract).not.toHaveBeenCalled();
    expect(await countSubjectNotes(T, personSubject('nogrant-user'))).toBe(0);
  });

  it('with consent, extracts + stores notes on the user subject (auto-extracted)', async () => {
    await setExtractionGrant(T, 'user:alice', true, 'alice');
    const r = await extractConversationMemory(T, 'alice', 'I work in Berlin and love cats', async () => ['lives in Berlin', 'likes cats']);
    expect(r.extracted).toBe(2);
    expect(await countSubjectNotes(T, personSubject('alice'))).toBe(2);
  });
});
