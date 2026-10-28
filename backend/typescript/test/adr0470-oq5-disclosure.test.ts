/**
 * ADR 0470 OQ5 — per-widget visitor-facing disclosure (businessName + privacyUrl).
 *
 * The privacyUrl is rendered as an <a href> in the PUBLIC widget on visitors' browsers,
 * so the load-bearing check is that a non-http(s) scheme (javascript:/data:) is REFUSED
 * server-side — a stored-XSS defense. Plus businessName capping + clear-on-null.
 *
 * Tracker TST-BG3-3. Red when: `cleanUrl` stops throwing for a non-http(s) scheme
 * (javascript:/data:/ftp: get stored), `cleanName` stops trimming or caps at a length
 * other than 80, the patch path swallows `cleanUrl`'s refusal, or `privacyUrl: null`
 * on patch stops clearing the stored URL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { provisionWidget, patchWidget, listWidgets, getWidget } from '../src/features/chat-widget/widgetService.js';

const T = 'oq5-t';
let orgN = 0;
/** A fresh org per case, so a widget count is never shared between cases. */
const freshOrg = (): string => `oq5-org-${++orgN}`;

const SCHEME_MSG = '`privacyUrl` must be an http(s) URL.';
const PARSE_MSG = '`privacyUrl` must be a valid http(s) URL.';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('ADR 0470 OQ5 — disclosure config validation', () => {
  it('persists an http(s) privacyUrl + a capped businessName', async () => {
    const w = await provisionWidget(T, freshOrg(), 'u', {
      agentId: 'a', allowedDomains: ['x.com'],
      businessName: '  Acme Inc.  ', privacyUrl: 'https://acme.example/privacy',
    });
    expect(w.businessName).toBe('Acme Inc.');
    expect(w.privacyUrl).toBe('https://acme.example/privacy');
  });

  it('REFUSES a javascript: privacyUrl (stored-XSS defense) — no widget created', async () => {
    const org = freshOrg();
    expect(await listWidgets(T, org)).toHaveLength(0);
    await expect(provisionWidget(T, org, 'u', {
      agentId: 'a', allowedDomains: ['x.com'], privacyUrl: 'javascript:alert(document.cookie)',
    })).rejects.toMatchObject({ code: 'validation_error', message: SCHEME_MSG });
    expect(await listWidgets(T, org)).toHaveLength(0);
  });

  it('REFUSES a data: privacyUrl and a non-URL string', async () => {
    const org = freshOrg();
    for (const [bad, message] of [
      ['data:text/html,<script>1</script>', SCHEME_MSG],
      ['not a url', PARSE_MSG],
      ['ftp://x.com/p', SCHEME_MSG],
    ] as const) {
      await expect(provisionWidget(T, org, 'u', { agentId: 'a', allowedDomains: ['x.com'], privacyUrl: bad }))
        .rejects.toMatchObject({ code: 'validation_error', message });
    }
    expect(await listWidgets(T, org)).toHaveLength(0);
  });

  it('caps businessName length and clears both on null via patch', async () => {
    const org = freshOrg();
    const w = await provisionWidget(T, org, 'u', { agentId: 'a', allowedDomains: ['x.com'], businessName: 'N'.repeat(200), privacyUrl: 'https://x.com/p' });
    expect(w.businessName).toBe('N'.repeat(80));
    const cleared = await patchWidget(T, org, w.widgetId, { businessName: null, privacyUrl: null });
    expect(cleared.businessName).toBeUndefined();
    expect(cleared.privacyUrl).toBeUndefined();
    // Read back: the clear was persisted, not just reflected in the response.
    const stored = await getWidget(T, org, w.widgetId);
    expect(stored?.businessName).toBeUndefined();
    expect(stored?.privacyUrl).toBeUndefined();
  });

  it('patch REFUSES a javascript: privacyUrl too', async () => {
    const org = freshOrg();
    const w = await provisionWidget(T, org, 'u', { agentId: 'a', allowedDomains: ['x.com'], privacyUrl: 'https://x.com/p' });
    await expect(patchWidget(T, org, w.widgetId, { privacyUrl: 'javascript:1' }))
      .rejects.toMatchObject({ code: 'validation_error', message: SCHEME_MSG });
    // The stored URL is the one that was there before the refused patch.
    expect((await getWidget(T, org, w.widgetId))?.privacyUrl).toBe('https://x.com/p');
  });
});
