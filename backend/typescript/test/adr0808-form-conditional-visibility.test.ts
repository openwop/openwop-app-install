/**
 * ADR 0808 — conditional field visibility (`form-content-packs.md`
 * §"Conditional visibility", RFC 0177 §E.4): a field's `when` is the workflow
 * edge-condition grammar, validated and evaluated by the SAME functions the
 * chain loader and the executor use.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeWhen, visibleFieldKeys } from '../src/host/formFieldConditions.js';
import { createForm, validateValues, type FormDef, type FormField } from '../src/features/forms/formsService.js';
import { createFormContentRegistry, loadFormContentPacks } from '../src/host/formContentPackLoader.js';

const SHIPPING: FormField = { key: 'shipping', label: 'Shipping', type: 'text', required: true };
const REGION: FormField = { key: 'region', label: 'Region', type: 'text', required: true, when: { type: 'equals', left: 'fields.shipping', right: 'international' } };
const POSTCODE: FormField = { key: 'postcode', label: 'Postcode', type: 'text', required: true, when: { type: 'truthy', left: 'fields.region' } };
const form = (fields: FormField[]): FormDef => ({ formId: 'f', fields } as unknown as FormDef);

describe('ADR 0808 — authoring: one grammar, earlier fields only', () => {
  it('accepts every operator the host evaluates, and drops a meaningless right', () => {
    const earlier = new Set(['shipping']);
    expect(sanitizeWhen({ type: 'equals', left: 'fields.shipping', right: 'international' }, 1, 'region', earlier))
      .toEqual({ type: 'equals', left: 'fields.shipping', right: 'international' });
    for (const type of ['notEquals', 'contains']) {
      expect(sanitizeWhen({ type, left: 'fields.shipping', right: 'x' }, 1, 'region', earlier)).toMatchObject({ type });
    }
    expect(sanitizeWhen({ type: 'truthy', left: 'fields.shipping', right: 'ignored' }, 1, 'region', earlier))
      .toEqual({ type: 'truthy', left: 'fields.shipping' });
  });

  it('refuses a second expression language, an unsupported operator, and a dead or forward reference', () => {
    const earlier = new Set(['shipping']);
    const refused = (when: unknown) => () => sanitizeWhen(when, 1, 'region', earlier);
    expect(refused({ op: 'eq', path: 'shipping', value: 'x' })).toThrow();           // not the edge grammar
    expect(refused({ type: 'jsonata', left: 'fields.shipping', right: 'x' })).toThrow(/unsupported/);
    expect(refused({ type: 'regex', left: 'fields.shipping', right: '^a' })).toThrow(/unsupported/);
    expect(refused({ type: 'expression', expression: 'true' })).toThrow(/unsupported/);
    expect(refused({ type: 'equals', left: 'shipping', right: 'x' })).toThrow(/fields\.<key>/);
    expect(refused({ type: 'equals', left: 'fields.later', right: 'x' })).toThrow(/earlier field/);
    expect(refused({ type: 'equals', left: 'fields.region', right: 'x' })).toThrow(/earlier field/); // itself
  });
});

describe('ADR 0808 — createForm keeps a valid when and refuses an invalid one', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  });
  it('round-trips through the same sanitizer a template instantiation uses', async () => {
    const f = await createForm({ tenantId: 't-0808', orgId: 'o-0808', title: 'Ship', createdBy: 'u', fields: [
      { key: 'shipping', label: 'Shipping', type: 'text' },
      { key: 'region', label: 'Region', type: 'text', required: true, when: { type: 'equals', left: 'fields.shipping', right: 'international' } },
    ] });
    expect(f.fields[1]?.when).toEqual({ type: 'equals', left: 'fields.shipping', right: 'international' });
    await expect(createForm({ tenantId: 't-0808', orgId: 'o-0808', title: 'Bad', createdBy: 'u', fields: [
      { key: 'region', label: 'Region', type: 'text', when: { type: 'equals', left: 'fields.shipping', right: 'x' } },
      { key: 'shipping', label: 'Shipping', type: 'text' },
    ] })).rejects.toThrow(/earlier field/);
  });
});

describe('ADR 0808 — submission: hidden means neither required nor kept', () => {
  it('a hidden required field is not required, and a value posted for it is dropped', () => {
    const out = validateValues(form([SHIPPING, REGION]), { shipping: 'domestic', region: 'smuggled' });
    expect(out).toEqual({ shipping: 'domestic' });
  });

  it('a shown required field is still required', () => {
    expect(() => validateValues(form([SHIPPING, REGION]), { shipping: 'international' })).toThrow(/region/);
    expect(validateValues(form([SHIPPING, REGION]), { shipping: 'international', region: 'EU' }))
      .toEqual({ shipping: 'international', region: 'EU' });
  });

  it('a hidden controller hides its dependents, even when a value for it was posted', () => {
    // region is hidden (domestic), so its posted value must not reveal postcode.
    expect(visibleFieldKeys([SHIPPING, REGION, POSTCODE], { shipping: 'domestic', region: 'EU' }))
      .toEqual(new Set(['shipping']));
    expect(validateValues(form([SHIPPING, REGION, POSTCODE]), { shipping: 'domestic', region: 'EU' }))
      .toEqual({ shipping: 'domestic' });
  });

  it('a form with no `when` anywhere behaves exactly as before', () => {
    const plain = { ...REGION, when: undefined } as FormField;
    expect(() => validateValues(form([SHIPPING, plain]), { shipping: 'domestic' })).toThrow(/region/);
  });
});

describe('ADR 0808 — the pack loader refuses what createForm would refuse', () => {
  let root = '';
  afterEach(() => { root = ''; });
  function packWith(when: unknown): string {
    root = mkdtempSync(join(tmpdir(), 'adr0808-'));
    mkdirSync(join(root, 'p'));
    writeFileSync(join(root, 'p', 'pack.json'), JSON.stringify({
      name: 'vendor.test.when', version: '1.0.0', kind: 'form-content',
      templates: [{
        templateId: 'vendor.test.when.shipping', version: '1.0.0', label: 'Shipping', title: 'Shipping',
        fields: [{ id: 'shipping', type: 'text', label: 'Shipping' }, { id: 'region', type: 'text', label: 'Region', when }],
      }],
    }));
    return root;
  }

  it('a template whose field carries when: { type: "equals" } loads, with when intact', () => {
    const registry = createFormContentRegistry();
    const out = loadFormContentPacks({ roots: [packWith({ type: 'equals', left: 'fields.shipping', right: 'international' })], registry });
    expect(out.errors).toEqual([]);
    const tpl = registry.get('vendor.test.when.shipping')?.template;
    expect(tpl?.fields[1]).toMatchObject({ key: 'region', when: { type: 'equals', left: 'fields.shipping', right: 'international' } });
  });

  it('a template using an operator this host cannot evaluate is refused by name', () => {
    const registry = createFormContentRegistry();
    const out = loadFormContentPacks({ roots: [packWith({ type: 'regex', left: 'fields.shipping', right: '^int' })], registry });
    expect(registry.has('vendor.test.when.shipping')).toBe(false);
    expect(JSON.stringify(out.errors)).toMatch(/region.*when/);
  });
});

describe('ADR 0808 — the server evaluator agrees with the public renderer, case for case', () => {
  // The SAME table the SPA's deriveFields.when.test.ts runs; a row the two
  // disagree on is a field the visitor sees but the server judges hidden.
  const table = JSON.parse(readFileSync(join(process.cwd(), '../../frontend/react/src/features/forms/render/whenCases.json'), 'utf8')) as {
    cases: Array<{ when: FormField['when']; a: unknown; shown: boolean }>;
  };
  it('has rows (a parity check over an empty table proves nothing)', () => { expect(table.cases.length).toBeGreaterThan(10); });
  it.each(table.cases)('$when.type on $a → shown=$shown', (c) => {
    const values = c.a === null ? {} : { a: c.a };
    expect(visibleFieldKeys([{ key: 'a' }, { key: 'b', when: c.when }], values).has('b')).toBe(c.shown);
  });
});
