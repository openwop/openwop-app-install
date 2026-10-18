/**
 * ADR 0127 Phase 1 — chat-widget config service (default-deny + token). Breaks if a
 * widget can be provisioned without a real domain allowlist or an agent, if a rotated
 * token keeps resolving, or if a widget reads or lists across tenants.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { provisionWidget, getWidget, listWidgets, patchWidget, resolveWidgetByToken, rotateWidgetToken, deleteWidget } from '../src/features/chat-widget/widgetService.js';

const T = 'wg-tenant';
const ORG = 'org-wg';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('chat-widget config service', () => {
  it('provisions a widget with a token + allowlist', async () => {
    const w = await provisionWidget(T, ORG, 'u1', { agentId: 'support', allowedDomains: ['acme.com', 'WWW.Acme.com'], caps: { maxTurnsPerSession: 10 } });
    expect(w.widgetId).toBeTruthy();
    expect(w.token).toMatch(/^wgt_/);
    expect(w.allowedDomains).toEqual(['acme.com', 'www.acme.com']); // normalized lowercase
    expect(w.caps.maxTurnsPerSession).toBe(10);
    expect(w.enabled).toBe(true);
  });

  it('DEFAULT-DENY: rejects an empty/missing allowedDomains', async () => {
    await expect(provisionWidget(T, ORG, 'u1', { agentId: 'support', allowedDomains: [] })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(provisionWidget(T, ORG, 'u1', { agentId: 'support' })).rejects.toMatchObject({ code: 'validation_error' });
    // A list of only blank entries is still empty after normalization.
    await expect(provisionWidget(T, ORG, 'u1', { agentId: 'support', allowedDomains: ['  ', ''] })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('requires an agentId', async () => {
    await expect(provisionWidget(T, ORG, 'u1', { allowedDomains: ['x.com'] })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('rotate-token replaces the token (invalidating embeds)', async () => {
    const w = await provisionWidget(T, ORG, 'u1', { agentId: 'a', allowedDomains: ['x.com'] });
    const rotated = await rotateWidgetToken(T, ORG, w.widgetId);
    expect(rotated.token).not.toBe(w.token);
    expect(rotated.token).toMatch(/^wgt_/);
    // The old embed credential stops resolving; the new one resolves to this widget.
    expect(await resolveWidgetByToken(w.token)).toBeNull();
    expect((await resolveWidgetByToken(rotated.token))?.widgetId).toBe(w.widgetId);
  });

  it('patches + lists + deletes; isolates by tenant/org', async () => {
    const w = await provisionWidget(T, ORG, 'u1', { agentId: 'a', allowedDomains: ['x.com'] });
    await patchWidget(T, ORG, w.widgetId, { enabled: false, caps: { maxSessionsPerDay: 5 } });
    expect((await getWidget(T, ORG, w.widgetId))!.enabled).toBe(false);
    expect((await getWidget(T, ORG, w.widgetId))!.caps.maxSessionsPerDay).toBe(5);
    expect(await getWidget('other', ORG, w.widgetId)).toBeNull(); // tenant isolation
    // Filter by id: other cases share T/ORG.
    expect((await listWidgets(T, ORG)).some((x) => x.widgetId === w.widgetId)).toBe(true);
    expect((await listWidgets('other', ORG)).some((x) => x.widgetId === w.widgetId)).toBe(false);
    await deleteWidget(T, ORG, w.widgetId);
    expect(await getWidget(T, ORG, w.widgetId)).toBeNull();
    expect((await listWidgets(T, ORG)).some((x) => x.widgetId === w.widgetId)).toBe(false);
  });
});
