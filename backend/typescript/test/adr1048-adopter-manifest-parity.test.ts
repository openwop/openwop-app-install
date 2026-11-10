/**
 * ADR 1048 — the adopter-manifest rules exist TWICE, on purpose: the generator
 * (`scripts/lib/adopter-pack-manifest.mjs`, runs before any build) and the
 * runtime (`src/host/adopterPackManifest.ts`, the image carries no scripts/lib).
 * If they disagree, `--check` passes a file the boot then rejects (every adopter
 * pack stops dispatching) or the reverse. The `pack-content-digest` arrangement:
 * one table, both implementations, identical codes.
 *
 * Red when (sabotage): any one rule is removed or loosened in ONE twin. The
 * table has a row for every rule: shape (each entry field, and `packs`),
 * shadows_steward, reserved_prefix, namespace (prefix lists AND the regex),
 * name_dir_mismatch, pin_version / pin_missing / pin_unattested,
 * typeid_upstream / typeid_namespace, floor_not_declared (served, held,
 * servedUnresolved) and replay_class (wildcard — declared or not —, another
 * pack's id, an unknown class). The constant tables, the namespace regex
 * included, are compared directly.
 */
import { describe, expect, it } from 'vitest';
import { validateAdopterManifest as tsValidate, type AdopterValidationContext } from '../src/host/adopterPackManifest.js';
import {
  validateAdopterManifest as mjsValidate,
  GRANDFATHERED_ADOPTER_PACK_IDS as MJS_GRANDFATHERED,
  RESERVED_PREFIXES as MJS_RESERVED,
  REPLAY_CLASSES as MJS_CLASSES,
  UPSTREAM_VENDOR_PREFIXES as MJS_UPSTREAM,
  ADOPTER_NAMESPACE as MJS_NAMESPACE,
} from '../../../scripts/lib/adopter-pack-manifest.mjs';
import {
  ADOPTER_NAMESPACE,
  GRANDFATHERED_ADOPTER_PACK_IDS,
  RESERVED_PREFIXES,
  REPLAY_CLASSES,
  UPSTREAM_VENDOR_PREFIXES,
} from '../src/host/adopterPackManifest.js';

const K = 'vendor.acme.nodes';
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: '1.0.0', files: 3, digest: 'd', declared: [`${K}.a`, `${K}.b`], served: [`${K}.a`],
  held: { 'ai-invocation-log': [`${K}.b`] }, servedUnresolved: [], ...over,
});
const base = (packs: Record<string, unknown> = { [K]: entry() }): unknown => ({ version: 1, packs });
const ctx = (over: Partial<AdopterValidationContext> = {}): AdopterValidationContext => ({
  stewardKeys: new Set(['core.openwop.ai', 'feature.crm.nodes']),
  pins: { [K]: '1.0.0' },
  upstreamDeclared: new Set(['core.openwop.ai.chat']),
  packNameOf: (d) => d,
  ...over,
});

const CASES: Array<[string, unknown, AdopterValidationContext, string[]]> = [
  ['valid', base(), ctx(), []],
  ['not an object', 'nope', ctx(), ['shape']],
  ['wrong version', { version: 2, packs: {} }, ctx(), ['shape']],
  ['entry missing digest', base({ [K]: entry({ digest: 1 }) }), ctx(), ['shape']],
  ['shadows a steward key', base({ 'feature.crm.nodes': entry({ declared: [], served: [], held: {} }) }), ctx({ pins: { 'feature.crm.nodes': '1.0.0' } }), ['namespace', 'shadows_steward']],
  ['reserved prefix', base({ 'community.openwop.x': entry({ declared: [], served: [], held: {} }) }), ctx({ pins: { 'community.openwop.x': '1.0.0' } }), ['reserved_prefix']],
  ['upstream vendor namespace', base({ 'vendor.openwop-app.x': entry({ declared: [], served: [], held: {} }) }), ctx({ pins: { 'vendor.openwop-app.x': '1.0.0' } }), ['namespace']],
  ['grandfathered id', base({ 'feature.kicktodo.nodes': entry({ declared: [], served: [], held: {} }) }), ctx({ pins: { 'feature.kicktodo.nodes': '1.0.0' } }), []],
  ['name ≠ dir', base(), ctx({ packNameOf: () => 'vendor.acme.other' }), ['name_dir_mismatch']],
  ['pin version', base(), ctx({ pins: { [K]: '1.0.1' } }), ['pin_version']],
  ['pin missing', base(), ctx({ pins: {} }), ['pin_missing']],
  ['no pin file at all', base(), ctx({ pins: null }), ['pin_missing']],
  ['pin unattested', base(), ctx({ pins: { [K]: '1.0.0', 'vendor.acme.agents': '1.0.0' } }), ['pin_unattested']],
  ['typeId is upstream', base({ [K]: entry({ declared: [`${K}.a`, `${K}.b`, 'core.openwop.ai.chat'] }) }), ctx(), ['typeid_namespace', 'typeid_upstream']],
  ['typeId outside own namespace', base({ [K]: entry({ declared: [`${K}.a`, `${K}.b`, 'vendor.other.x'] }) }), ctx(), ['typeid_namespace']],
  ['served not declared', base({ [K]: entry({ served: [`${K}.z`] }) }), ctx(), ['floor_not_declared']],
  ['replayClass wildcard', base({ [K]: entry({ replayClass: { [`${K}.*`]: 'pure' } }) }), ctx(), ['replay_class']],
  ['replayClass bad class', base({ [K]: entry({ replayClass: { [`${K}.a`]: 'skip' } }) }), ctx(), ['replay_class']],
  ['replayClass ok', base({ [K]: entry({ replayClass: { [`${K}.a`]: 'pure', [`${K}.b`]: 'served' } }) }), ctx(), []],
  // floor_not_declared — every leg of the floor half, not only `served`.
  ['held not declared', base({ [K]: entry({ held: { 'ai-invocation-log': [`${K}.b`, `${K}.z`] } }) }), ctx(), ['floor_not_declared']],
  ['servedUnresolved not declared', base({ [K]: entry({ servedUnresolved: [`${K}.z`] }) }), ctx(), ['floor_not_declared']],
  // replay_class — a wildcard is refused even when the pack DECLARES that id
  // (otherwise `!declared.has` masks the `*` rule), and another pack's id is refused.
  ['replayClass names a DECLARED wildcard id', base({ [K]: entry({ declared: [`${K}.a`, `${K}.b`, `${K}.*`], replayClass: { [`${K}.*`]: 'pure' } }) }), ctx(), ['replay_class']],
  ['replayClass names another pack\'s id', base({ [K]: entry({ replayClass: { 'vendor.other.x': 'pure' } }) }), ctx(), ['replay_class']],
  // shape — each field of the entry, and `packs` itself.
  ['shape: packs not an object', { version: 1, packs: [] }, ctx(), ['shape']],
  ['shape: files not a number', base({ [K]: entry({ files: '3' }) }), ctx(), ['shape']],
  ['shape: version not a string or null', base({ [K]: entry({ version: 1 }) }), ctx(), ['shape']],
  ['shape: declared not a string array', base({ [K]: entry({ declared: 'x' }) }), ctx(), ['shape']],
  ['shape: served not a string array', base({ [K]: entry({ served: 'x' }) }), ctx(), ['shape']],
  ['shape: a held bucket not a string array', base({ [K]: entry({ held: { a: 'x' } }) }), ctx(), ['shape']],
  ['shape: servedUnresolved not a string array', base({ [K]: entry({ servedUnresolved: 'x' }) }), ctx(), ['shape']],
  ['shape: replayClass not an object', base({ [K]: entry({ replayClass: [] }) }), ctx(), ['shape']],
  // namespace — the vendor.<adopter>.<pack> regex itself, past the prefix lists.
  ['namespace: upper case', base({ 'vendor.Acme.nodes': entry({ declared: [], served: [], held: {} }) }), ctx({ pins: { 'vendor.Acme.nodes': '1.0.0' } }), ['namespace']],
  ['namespace: no pack segment', base({ 'vendor.acme': entry({ declared: [], served: [], held: {} }) }), ctx({ pins: { 'vendor.acme': '1.0.0' } }), ['namespace']],
  ['namespace: empty adopter segment', base({ 'vendor..x': entry({ declared: [], served: [], held: {} }) }), ctx({ pins: { 'vendor..x': '1.0.0' } }), ['namespace']],
];

const codes = (v: Array<{ code: string }>): string[] => [...new Set(v.map((x) => x.code))].sort();

describe('ADR 1048 — generator and runtime validate the adopter manifest identically', () => {
  it.each(CASES)('%s', (_label, manifest, c, expected) => {
    const ts = codes(tsValidate(manifest, c));
    const mjs = codes(mjsValidate(manifest, c));
    expect(ts).toEqual(expected);
    expect(mjs).toEqual(ts);
  });

  it('the constant tables are identical', () => {
    expect([...RESERVED_PREFIXES]).toEqual([...MJS_RESERVED]);
    expect([...UPSTREAM_VENDOR_PREFIXES]).toEqual([...MJS_UPSTREAM]);
    expect([...GRANDFATHERED_ADOPTER_PACK_IDS]).toEqual([...MJS_GRANDFATHERED]);
    expect([...REPLAY_CLASSES]).toEqual([...MJS_CLASSES]);
    // The namespace regex, read from both twins (a loosened copy in one twin
    // passes the prefix-list rows above).
    expect(ADOPTER_NAMESPACE.source).toBe(MJS_NAMESPACE.source);
    expect(ADOPTER_NAMESPACE.flags).toBe(MJS_NAMESPACE.flags);
    expect(ADOPTER_NAMESPACE.source).toBe('^vendor\\.[a-z0-9][a-z0-9-]*\\.[a-z0-9][a-z0-9.-]*$');
    // D7: exactly KickTodo's two ids, nothing prefix-shaped.
    expect([...GRANDFATHERED_ADOPTER_PACK_IDS].sort()).toEqual(['feature.kicktodo.nodes', 'vendor.openwop-app.kicktodo.agents']);
  });
});
