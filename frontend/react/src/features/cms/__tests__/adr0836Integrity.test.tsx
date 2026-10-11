/**
 * ADR 0836 — the browser half of two server rules:
 * - D7: a CTA whose URL carries a control character (`"/\t/evil.com"`, which a
 *   URL parser resolves to `https://evil.com/`) is not rendered as a link.
 * - D6/D9: the two new refusals map to their own copy instead of the generic
 *   "no permission" / a bare server message.
 *
 * Sabotage-witnessed (/grade-tests w17): CtaLink back on the old `/^\/(?![/\\])/`
 * regex → case 1 red; CtaLink never rendering an internal Link → case 2 red;
 * `cmsErrorInfo` always `errLiveTier` / always `errPublishBlocked` → cases 3 / 4 red.
 * The predicate's full vector table lives in
 * `backend/typescript/test/adr0836-internal-href.test.ts`; this file is the only
 * RENDER-level check that the CTA exit uses it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { CmsApiError, cmsErrorInfo } from '../cmsClient.js';

afterEach(cleanup);

describe('ADR 0836 D7 — CTA links use the shared internal-path predicate', () => {
  it('"/\\t/evil.com" is not a link', () => {
    render(
      <MemoryRouter>
        <RenderSection section={{ sectionId: 's1', type: 'cta', data: { heading: 'Go', label: 'Start now', url: '/\t/evil.com' } }} mode="public" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: 'Start now' })).toBeNull();
  });

  it('a plain internal path still is', () => {
    render(
      <MemoryRouter>
        <RenderSection section={{ sectionId: 's1', type: 'cta', data: { heading: 'Go', label: 'Start now', url: '/signup' } }} mode="public" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Start now' }).getAttribute('href')).toBe('/signup');
  });
});

describe('ADR 0836 — refusal copy', () => {
  it('a live-tier 403 names the admin requirement', () => {
    expect(cmsErrorInfo(new CmsApiError('x', 'forbidden_scope', 403, { requiredScope: 'host:members:manage', reason: 'live_tier' }))).toEqual({ key: 'errLiveTier' });
    // Publish/schedule are admin tier too, but not "the page is live".
    expect(cmsErrorInfo(new CmsApiError('x', 'forbidden_scope', 403, { requiredScope: 'host:members:manage' }))).toEqual({ key: 'errForbidden' });
  });

  it('a publish blocker names the [TODO] markers', () => {
    expect(cmsErrorInfo(new CmsApiError('x', 'validation_error', 422, { reason: 'publish_blocked' }))).toEqual({ key: 'errPublishBlocked' });
    expect(cmsErrorInfo(new CmsApiError('x', 'validation_error', 400, {}))).toBeNull();
  });
});
