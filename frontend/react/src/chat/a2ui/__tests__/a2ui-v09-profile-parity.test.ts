import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILE, PROFILE_COMPONENTS, A2UI_V09_CATALOG_IDS, parseV09Payload, A2UI_V09_CATALOG_ID } from '../v09/profile.js';

/**
 * The hand-written render-side profile (`v09/profile.ts`) MUST equal the
 * vendored wire schema's `payloadV2` — the same closed component set, the same
 * properties per component, the same required set and enums, the same pinned
 * catalog. A renderer that admits more than the host admits is a second,
 * looser gate; one that admits less refuses surfaces the host recorded.
 */
type Def = { properties?: Record<string, { enum?: string[]; $ref?: string }>; required?: string[]; anyOf?: Array<{ $ref: string }> ; enum?: string[] };
const schema = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'schemas', 'v2', 'envelopes', 'ui.a2ui-surface.schema.json'), 'utf8')) as { $defs: Record<string, Def> };
const defs = schema.$defs;
const refName = (r: string) => r.replace('#/$defs/', '');
const sid = 's';
const wrap = (c: unknown) => ({ version: 'v0.9', catalogId: A2UI_V09_CATALOG_ID, surfaceId: sid, messages: [{ version: 'v0.9', updateComponents: { surfaceId: sid, components: [c] } }] });
const SHAPE = /has a property or value the A2UI v0\.9 profile does not allow/;

describe('A2UI v0.9 render profile ⇔ schemas/v2 payloadV2', () => {
  it('the component set is exactly the schema\'s', () => {
    const fromSchema = (defs.component!.anyOf ?? []).map((b) => refName(b.$ref)).sort();
    expect([...PROFILE_COMPONENTS].sort()).toEqual(fromSchema);
  });
  it.each(Object.keys(PROFILE))('%s: same properties, required set and enums', (name) => {
    const d = defs[name]!;
    const spec = PROFILE[name as keyof typeof PROFILE];
    expect(Object.keys(spec.props).sort()).toEqual(Object.keys(d.properties ?? {}).sort());
    expect([...spec.required].sort()).toEqual([...(d.required ?? [])].sort());
    for (const [prop, p] of Object.entries(d.properties ?? {})) {
      if (prop === 'component') continue;
      if (!p.enum) continue;
      expect([...(spec.enums[prop] ?? [])].sort(), `${name}.${prop}`).toEqual([...p.enum].sort());
      // Behavioural parity: the CHECKER that validates the prop (not just the enums
      // record) admits every schema value and refuses one outside the enum.
      const ok = spec.props[prop]!;
      for (const v of p.enum) expect(ok(v), `${name}.${prop}=${v}`).toBe(true);
      expect(ok('__not_in_enum__'), `${name}.${prop}`).toBe(false);
    }
  });
  it('the pinned catalog is the schema\'s catalogId enum', () => {
    expect([...A2UI_V09_CATALOG_IDS]).toEqual(defs.catalogId!.enum);
  });
  it('the action event names are the schema\'s', () => {
    const ev = (defs.action!.properties!.event as unknown as { properties: { name: { enum: string[] } } }).properties.name.enum;
    expect(ev.sort()).toEqual(['exchange', 'resume']);
    // …and the profile admits exactly those on a Button.
    for (const n of ev) expect(parseV09Payload(wrap({ id: 'b', component: 'Button', child: 'b', action: { event: { name: n } } })).ok, n).toBe(true);
  });
});

describe('the profile refuses what upstream A2UI admits', () => {
  /** The refusal reason, or a failure when the payload was admitted. */
  const reasonOf = (payload: unknown): string => {
    const r = parseV09Payload(payload);
    if (r.ok) throw new Error('admitted');
    return r.reason;
  };
  it('CONTROL: the wrapper admits a valid component', () => {
    expect(parseV09Payload(wrap({ id: 't', component: 'Text', text: 'x' })).ok).toBe(true);
  });
  it.each([
    ['functionCall openUrl', { id: 'b', component: 'Button', child: 'l', action: { functionCall: { call: 'openUrl', args: { url: 'https://evil.example/' } } } }, SHAPE],
    ['event outside resume/exchange', { id: 'b', component: 'Button', child: 'l', action: { event: { name: 'deleteAll' } } }, SHAPE],
    ['obscured text field', { id: 't', component: 'TextField', label: 'Password', variant: 'obscured' }, SHAPE],
    ['Image', { id: 'i', component: 'Image', url: 'https://evil.example/x.png' }, /the component "Image" is not in the A2UI v0\.9 profile/],
    ['formatString text', { id: 't', component: 'Text', text: { call: 'formatString', args: {} } }, SHAPE],
    ['extra property', { id: 't', component: 'Text', text: 'x', onClick: 'x' }, SHAPE],
  ])('%s', (_n, c, reason) => {
    expect(reasonOf(wrap(c))).toMatch(reason);
  });
  it('theme.iconUrl and a foreign catalog are refused', () => {
    const create = (theme: Record<string, unknown>) => ({ version: 'v0.9', catalogId: A2UI_V09_CATALOG_ID, surfaceId: sid, messages: [{ version: 'v0.9', createSurface: { surfaceId: sid, catalogId: A2UI_V09_CATALOG_ID, theme } }] });
    // CONTROL: the same createSurface with an allowed theme property is admitted.
    expect(parseV09Payload(create({ agentDisplayName: 'A' })).ok).toBe(true);
    expect(reasonOf(create({ iconUrl: 'https://evil.example/i.png' }))).toBe('message 0 is not a valid A2UI v0.9 message for this surface');
    expect(reasonOf({ version: 'v0.9', catalogId: 'https://example.test/other.json', surfaceId: sid, messages: [{ version: 'v0.9', deleteSurface: { surfaceId: sid } }] })).toBe('the surface names a catalog this host does not pin');
  });
  it('a message for another surface is refused', () => {
    // CONTROL: the same message for this surface is admitted.
    expect(parseV09Payload({ version: 'v0.9', catalogId: A2UI_V09_CATALOG_ID, surfaceId: sid, messages: [{ version: 'v0.9', deleteSurface: { surfaceId: sid } }] }).ok).toBe(true);
    expect(reasonOf({ version: 'v0.9', catalogId: A2UI_V09_CATALOG_ID, surfaceId: sid, messages: [{ version: 'v0.9', deleteSurface: { surfaceId: 'other' } }] })).toBe('message 0 is not a valid A2UI v0.9 message for this surface');
  });
});
