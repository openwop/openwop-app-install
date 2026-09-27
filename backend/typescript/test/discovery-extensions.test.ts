/**
 * host/discoveryExtensions — the `<org>.<name>` record seam behind the v2 advertisement's
 * `extensions` block (RFC 0169 §A.4; `spec/v2/declaration.json` extensionsKeyPattern +
 * reservedOrgs). Pure unit test: the seam refuses what the wire must never carry and
 * omits (never half-advertises) a record that throws.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { __resetV2Extensions, V2_EXTENSION_KEY, listV2ExtensionKeys, registerV2Extension, v2Extensions } from '../src/host/discoveryExtensions.js';

afterEach(() => __resetV2Extensions());

describe('registerV2Extension / v2Extensions', () => {
  it('accepts <org>.<name> keys per the corpus pattern and returns live records', () => {
    let n = 0;
    registerV2Extension('acme.recruiting', () => ({ status: 'experimental', calls: ++n }));
    expect(listV2ExtensionKeys()).toEqual(['acme.recruiting']);
    expect(v2Extensions().extensions['acme.recruiting']).toMatchObject({ calls: 1 });
    expect(v2Extensions().extensions['acme.recruiting']).toMatchObject({ calls: 2 });   // evaluated per call — live, not a snapshot
  });
  it('refuses malformed keys, reserved orgs, and non-function records', () => {
    for (const bad of ['Acme.thing', 'acme', 'acme.', 'acme.Thing', 'acme..thing', 'acme.thing.extra', '-acme.thing']) expect(() => registerV2Extension(bad, () => ({})), bad).toThrow(/key pattern/);
    expect(() => registerV2Extension('openwop.thing', () => ({}))).toThrow(/reserved/);
    expect(() => registerV2Extension('vendor.thing', () => ({}))).toThrow(/reserved/);
    expect(() => registerV2Extension('acme.thing', {} as never)).toThrow(/function/);
    expect(V2_EXTENSION_KEY.test('openwop-app.host')).toBe(true);
  });
  it('omits a record that throws and names it in `failed` — never a half-advertised claim', () => {
    registerV2Extension('acme.ok', () => ({ a: 1 }));
    registerV2Extension('acme.broken', () => { throw new Error('boom'); });
    const r = v2Extensions();
    expect(Object.keys(r.extensions)).toEqual(['acme.ok']);
    expect(r.failed).toEqual(['acme.broken']);
  });
});
