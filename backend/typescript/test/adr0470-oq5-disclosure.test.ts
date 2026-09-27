/**
 * ADR 0470 OQ5 — per-widget visitor-facing disclosure (businessName + privacyUrl).
 *
 * The privacyUrl is rendered as an <a href> in the PUBLIC widget on visitors' browsers,
 * so the load-bearing check is that a non-http(s) scheme (javascript:/data:) is REFUSED
 * server-side — a stored-XSS defense. Plus businessName capping + clear-on-null.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { provisionWidget, patchWidget } from '../src/features/chat-widget/widgetService.js';

const T = 'oq5-t';
const ORG = 'oq5-org';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('ADR 0470 OQ5 — disclosure config validation', () => {
  it('persists an http(s) privacyUrl + a capped businessName', async () => {
    const w = await provisionWidget(T, ORG, 'u', {
      agentId: 'a', allowedDomains: ['x.com'],
      businessName: '  Acme Inc.  ', privacyUrl: 'https://acme.example/privacy',
    });
    expect(w.businessName).toBe('Acme Inc.');
    expect(w.privacyUrl).toBe('https://acme.example/privacy');
  });

  it('REFUSES a javascript: privacyUrl (stored-XSS defense) — no widget created', async () => {
    await expect(provisionWidget(T, ORG, 'u', {
      agentId: 'a', allowedDomains: ['x.com'], privacyUrl: 'javascript:alert(document.cookie)',
    })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('REFUSES a data: privacyUrl and a non-URL string', async () => {
    for (const bad of ['data:text/html,<script>1</script>', 'not a url', 'ftp://x.com/p']) {
      await expect(provisionWidget(T, ORG, 'u', { agentId: 'a', allowedDomains: ['x.com'], privacyUrl: bad }))
        .rejects.toMatchObject({ code: 'validation_error' });
    }
  });

  it('caps businessName length and clears both on null via patch', async () => {
    const w = await provisionWidget(T, ORG, 'u', { agentId: 'a', allowedDomains: ['x.com'], businessName: 'N'.repeat(200), privacyUrl: 'https://x.com/p' });
    expect(w.businessName!.length).toBe(80);
    const cleared = await patchWidget(T, ORG, w.widgetId, { businessName: null, privacyUrl: null });
    expect(cleared.businessName).toBeUndefined();
    expect(cleared.privacyUrl).toBeUndefined();
  });

  it('patch REFUSES a javascript: privacyUrl too', async () => {
    const w = await provisionWidget(T, ORG, 'u', { agentId: 'a', allowedDomains: ['x.com'] });
    await expect(patchWidget(T, ORG, w.widgetId, { privacyUrl: 'javascript:1' })).rejects.toMatchObject({ code: 'validation_error' });
  });
});
