/**
 * The notification click-through spine (bell drawer + /inbox share these).
 *
 *  - `actionLabelKeyFor` — every label a row can render resolves to a real
 *    catalog key (a missing key ships a raw key in the inbox), and a failure
 *    that links to /connections is labelled as the fix, not "View run".
 *  - `isSafeActionUrl` — the in-app-only rule (2026-07 vuln-scan): a
 *    server-provided `actionUrl` reaches `<Link to>`, the desktop toast and the
 *    native shell (`navigateToActionUrl`); an off-origin, protocol-relative,
 *    backslash, whitespace, control-character or over-long value would be an
 *    open redirect. The service worker's copy is pinned to this rule by
 *    `swPushActionUrlParity.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { actionLabelKeyFor, isSafeActionUrl } from '../actionLabels.js';
import { KNOWN_TYPES } from '../types.js';
import { messages as en } from '../i18n/en.js';

describe('actionLabelKeyFor', () => {
  it('maps every known type to a catalog key that exists in the en locale', () => {
    // The label a notification renders must resolve to a real i18n key — a
    // missing key would ship an untranslated placeholder in the inbox. The
    // entity types the map labels beyond KNOWN_TYPES are listed literally.
    const entityTypes = [
      'commerce.order.paid', 'commerce.ucp-buyer.placed', 'commerce.ucp-buyer.status', 'campaign.pacing',
      'comment.added', 'comment.reply', 'comment.mention', 'comment.resolved', 'task.assigned',
      'agent.deliverable', 'agent.escalation', 'assistant.briefing',
    ];
    for (const type of [...KNOWN_TYPES, ...entityTypes]) {
      const key = actionLabelKeyFor(type);
      expect(en, `en.${key} missing for type ${type}`).toHaveProperty(key);
    }
  });

  it('labels a failure that links to Connections as the fix, not "View run"', () => {
    expect(actionLabelKeyFor('workflow.failed', '/connections')).toBe('actionReconnect');
    expect(actionLabelKeyFor('workflow.failed', '/connections?provider=google')).toBe('actionReconnect');
    expect(actionLabelKeyFor('workflow.failed', '/runs/r-1')).toBe('actionViewRun');
    expect(actionLabelKeyFor('workflow.failed', '/connectionsfoo')).toBe('actionViewRun');
    expect(en).toHaveProperty('actionReconnect');
  });

  it('maps the entity notification types to their specific verbs', () => {
    expect(actionLabelKeyFor('commerce.order.paid')).toBe('actionViewOrder');
    expect(actionLabelKeyFor('commerce.ucp-buyer.placed')).toBe('actionViewPurchase');
    expect(actionLabelKeyFor('commerce.ucp-buyer.status')).toBe('actionViewPurchase');
    expect(actionLabelKeyFor('campaign.pacing')).toBe('actionViewCampaign');
    expect(actionLabelKeyFor('comment.added')).toBe('actionViewComment');
    expect(actionLabelKeyFor('task.assigned')).toBe('actionViewCard');
    expect(actionLabelKeyFor('chat.channel_post')).toBe('actionOpenChannel');
  });

  it('falls back to the generic view label for an unknown open-wire type', () => {
    expect(actionLabelKeyFor('some.future.type')).toBe('actionView');
    expect(en).toHaveProperty('actionView');
  });
});

describe('isSafeActionUrl', () => {
  it('accepts in-app absolute paths', () => {
    expect(isSafeActionUrl('/commerce/orders/ord_1')).toBe(true);
    expect(isSafeActionUrl('/commerce?tab=orders&order=ord_1')).toBe(true);
    expect(isSafeActionUrl('/')).toBe(true);
  });

  it('rejects undefined, empty, and non-rooted paths', () => {
    expect(isSafeActionUrl(undefined)).toBe(false);
    expect(isSafeActionUrl('')).toBe(false);
    expect(isSafeActionUrl('commerce/orders/1')).toBe(false);
  });

  it('rejects protocol-relative, scheme, and control-char smuggling', () => {
    expect(isSafeActionUrl('//evil.example.com')).toBe(false);
    expect(isSafeActionUrl('https://evil.example.com')).toBe(false);
    expect(isSafeActionUrl('/path\\to')).toBe(false);
    expect(isSafeActionUrl('/path with space')).toBe(false);
    expect(isSafeActionUrl('/path\nnewline')).toBe(false);
    // Control characters that are NOT whitespace — only the char-code loop
    // rejects these (`\s` does not match NUL or DEL).
    expect(isSafeActionUrl('/a\u0000b')).toBe(false);
    expect(isSafeActionUrl('/a\u007fb')).toBe(false);
  });

  it('rejects an over-long path', () => {
    expect(isSafeActionUrl('/' + 'a'.repeat(3000))).toBe(false);
    // The boundary: 2048 characters is allowed, 2049 is not.
    expect(isSafeActionUrl('/' + 'a'.repeat(2047))).toBe(true);
    expect(isSafeActionUrl('/' + 'a'.repeat(2048))).toBe(false);
  });
});
