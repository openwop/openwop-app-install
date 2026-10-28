/**
 * XCH-UP-3 (Book AI) — a template copy with blank inputs names them. Red under:
 * dropping the unfilledParams notice, or the plural forms missing (they render
 * the key instead of text).
 */
import { describe, expect, it } from 'vitest';
import i18n from 'i18next';
import { messages as en } from '../i18n/en.js';
import { fromChainNotices } from '../fromChainNotices.js';

const inst = i18n.createInstance();
await inst.init({ lng: 'en', resources: { en: { builder: en } }, defaultNS: 'builder', interpolation: { escapeValue: false } });
const t = inst.getFixedT('en', 'builder');

describe('fromChainNotices', () => {
  it('names blank template inputs, singular and plural', () => {
    expect(fromChainNotices({ unfilledParams: ['topic'] }, t)).toEqual(['Copied — but 1 template input is still blank: topic. A run will fail until you fill it in.']);
    expect(fromChainNotices({ unfilledParams: ['topic', 'orgId'] }, t)[0]).toBe('Copied — but 2 template inputs are still blank: topic, orgId. A run will fail until you fill them in.');
  });

  it('keeps the incomplete-config and missing-node notices, in order', () => {
    const notes = fromChainNotices({ incompleteNodes: [{ nodeId: 'a', typeId: 'x', missing: ['url'] }], unfilledParams: ['p'], warnings: ['core.x'] }, t);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain('url');
    expect(notes[1]).toContain('p');
    expect(notes[2]).toContain('core.x');
  });

  it('a complete copy says nothing', () => {
    expect(fromChainNotices({}, t)).toEqual([]);
  });
});
