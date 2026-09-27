/**
 * ADR 0331 §D2 (backend half) — the CMS sanitizer accepts the `form` section
 * (a validated { formId } REFERENCE, orgId as editor convenience) and rejects
 * a form section without a formId. Pins the gap the live E2E caught: the
 * section type existed only in the FRONTEND union at first.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createPage, updatePage, SECTION_TYPES } from '../src/features/cms/cmsService.js';

const T = 'tenant-cfs'; const ORG = 'org:cfs'; const USER = 'user:cfs';

describe('cms form section (ADR 0331 backend)', () => {
  beforeEach(() => initHostExtPersistence(openSqliteStorage(':memory:')));

  it('form is a known section type and a formId reference round-trips', async () => {
    expect(SECTION_TYPES).toContain('form');
    const page = await createPage({ tenantId: T, orgId: ORG, title: 'Capture', createdBy: USER });
    const next = await updatePage(T, ORG, page.pageId, {
      sections: [{ type: 'form', data: { formId: 'form:abc-123', orgId: ORG } }],
    }, USER);
    expect(next?.sections[0]?.type).toBe('form');
    expect(next?.sections[0]?.data.formId).toBe('form:abc-123');
  });

  it('rejects a form section without a formId', async () => {
    const page = await createPage({ tenantId: T, orgId: ORG, title: 'Bad', createdBy: USER });
    await expect(updatePage(T, ORG, page.pageId, {
      sections: [{ type: 'form', data: {} }],
    }, USER)).rejects.toThrow(/formId/);
  });
});
