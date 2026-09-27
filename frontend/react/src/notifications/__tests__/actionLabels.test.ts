import { describe, it, expect } from 'vitest';
import { actionLabelKeyFor, isSafeActionUrl } from '../actionLabels.js';
import { KNOWN_TYPES } from '../types.js';
import { messages as en } from '../i18n/en.js';

describe('actionLabelKeyFor', () => {
  it('maps every known type to a catalog key that exists in the en locale', () => {
    // The label a notification renders must resolve to a real i18n key — a
    // missing key would ship an untranslated placeholder in the inbox.
    for (const type of KNOWN_TYPES) {
      const key = actionLabelKeyFor(type);
      expect(en, `en.${key} missing for type ${type}`).toHaveProperty(key);
    }
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
  });

  it('rejects an over-long path', () => {
    expect(isSafeActionUrl('/' + 'a'.repeat(3000))).toBe(false);
  });
});
