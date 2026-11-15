import { describe, it, expect } from 'vitest';
import { CmsApiError, cmsErrorInfo } from '../cmsClient.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

/**
 * CMS-UX-1 (found live on prod 2026-11-14 while attempting CT-1112-17). With the
 * approval gate on, editing a shared section a published page uses is refused 409.
 * The server's English message names the page and the remedy, but a Spanish editor
 * received the generic "La solicitud entra en conflicto…", because the error
 * envelope localizes `message` per code. `cmsErrorInfo` now rebuilds the message
 * from `details`, so it reaches the editor in their language.
 */
const gate = (details: Record<string, unknown>): CmsApiError =>
  new CmsApiError('La solicitud entra en conflicto con el estado actual del recurso.', 'conflict', 409, { gate: 'cms-approval-gate', ...details });

describe('cmsErrorInfo — the approval-gate refusal', () => {
  it('names the live page from the payload prod returned for a shared-section edit', () => {
    const e = gate({ sharedSectionId: 'shsec:x', pages: [{ pageId: 'page:1', title: 'Build schedule', slug: 'build', status: 'published' }], locale: 'es' });
    expect(cmsErrorInfo(e)).toEqual({ key: 'errGateLive', options: { pages: '“Build schedule”' } });
  });

  it('splits live pages from pages under review, as the server does', () => {
    const pages = [{ title: 'A', status: 'published' }, { title: 'B', status: 'in_review' }, { title: 'C', status: 'published' }];
    expect(cmsErrorInfo(gate({ pages }))).toEqual({ key: 'errGateLiveAndReview', options: { live: '“A”, “C”', reviewing: '“B”' } });
    expect(cmsErrorInfo(gate({ pages: [{ title: 'B', status: 'in_review' }] }))).toEqual({ key: 'errGateReview', options: { pages: '“B”' } });
  });

  it('a live page edited in place, and any other gate refusal, still get a specific message', () => {
    expect(cmsErrorInfo(gate({ pageId: 'page:1', status: 'published' }))).toEqual({ key: 'errGatePageLive' });
    expect(cmsErrorInfo(gate({ reason: 'unreviewed_snapshot' }))).toEqual({ key: 'errGateApproval' });
  });

  it('leaves other conflicts on their own message', () => {
    expect(cmsErrorInfo(new CmsApiError('stale', 'conflict', 409, { reason: 'version_conflict' }))).toBeNull();
  });

  it('every locale has the keys, with the same placeholders', () => {
    const keys = { errGateLive: ['pages'], errGateReview: ['pages'], errGateLiveAndReview: ['live', 'reviewing'], errGatePageLive: [], errGateApproval: [] } as const;
    for (const [locale, table] of Object.entries({ en, es, fr, 'pt-BR': ptBR }) as Array<[string, Record<string, string>]>) {
      for (const [key, vars] of Object.entries(keys)) {
        const text = table[key];
        expect(typeof text, `${locale}.${key}`).toBe('string');
        expect([...text!.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort(), `${locale}.${key}`).toEqual([...vars].sort());
      }
    }
  });
});
