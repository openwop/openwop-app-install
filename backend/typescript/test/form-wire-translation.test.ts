/**
 * RFC 0137 §Instantiation — the pack boundary translates WIRE field types into
 * host types, and zero stored rows move.
 *
 * The wire enum governs the WIRE. Renaming stored types would mean a stored
 * `checkbox` coerces to `text` on the next ordinary save — and `emailOptInField`
 * REQUIRES `checkbox` and throws 400, so every form with a marketing opt-in
 * becomes UNSAVEABLE (ADR 0338 consent machinery). Hence: translate here.
 *
 * TST-DEA-1 — red when: a WIRE_TO_HOST target or wire type is dropped/renamed,
 * the email fold or `id`→`key` rename is removed, the `vendor.`/`x-` extension
 * carve-out or `declaredType` is lost, the loader stops calling
 * `wireFieldToHost`, or the templateId-scope / SemVer / unknown-type refusals
 * are loosened (each sabotage-witnessed, wave 70).
 * Overlap (kept, dedupe-needs-human-ask): `form-content-packs.test.ts` ›
 * "REFUSES an out-of-catalog field type" also refuses an unknown type; this file
 * owns the extension carve-out boundary next to it.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import {
  WIRE_TYPES, WIRE_TO_HOST, wireFieldToHost,
  loadFormContentPacks, getFormTemplate, _resetFormContentRegistryForTest,
} from '../src/host/formContentPackLoader.js';
import { FIELD_TYPES } from '../src/features/forms/formsService.js';

const dirs: string[] = [];
function packRoot(templates: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'wire-xlate-'));
  dirs.push(root);
  mkdirSync(join(root, 'test.forms'), { recursive: true });
  writeFileSync(join(root, 'test.forms', 'pack.json'), JSON.stringify({
    name: 'test.forms', version: '1.0.0', kind: 'form-content', templates,
  }), 'utf8');
  return root;
}
afterEach(() => {
  _resetFormContentRegistryForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('RFC 0137 — wire → host field translation', () => {
  it('every translation target is a REAL host type', () => {
    // The invariant that keeps the map honest: a typo'd target would silently
    // produce a field the service then coerces to text.
    for (const [wire, host] of Object.entries(WIRE_TO_HOST)) {
      expect(FIELD_TYPES as readonly string[], `${wire} → ${host} is not a host type`).toContain(host);
    }
  });

  it('covers every wire type — no silent gap', () => {
    // Two-sided: every wire type has a mapping AND the map names nothing else.
    expect(Object.keys(WIRE_TO_HOST).sort()).toEqual([...WIRE_TYPES].sort());
  });

  it('maps the data-kind names onto the host widget names', () => {
    expect(wireFieldToHost({ id: 'a', type: 'longtext' }).type).toBe('textarea');
    expect(wireFieldToHost({ id: 'b', type: 'boolean' }).type).toBe('checkbox');
    expect(wireFieldToHost({ id: 'c', type: 'number' }).type).toBe('number');
  });

  it('folds `text` + format:email into the host `email` type', () => {
    // RFC 0137: email is a validation FORMAT, not a data kind. The host models
    // it as a type, and `validateValues` derives EMAIL_RE from `type === email`.
    const out = wireFieldToHost({ id: 'e', type: 'text', format: 'email' });
    expect(out.type).toBe('email');
    expect(out.format).toBeUndefined();
  });

  it('renames `id` → `key` — WIRE-ONLY, storage keeps `key`', () => {
    // `FormField.key` is the submission value key (`submission.values[key]`)
    // and `intakeBinding` maps by it; renaming stored keys breaks every
    // existing submission.
    const out = wireFieldToHost({ id: 'guests', type: 'number' });
    expect(out.key).toBe('guests');
    expect(out.id).toBeUndefined();
  });

  it('DEGRADES a vendor extension to plain text rather than failing', () => {
    // Spec §Instantiation #2 — MUST degrade, not refuse. This is the
    // forward-compat escape hatch.
    expect(wireFieldToHost({ id: 'x', type: 'vendor.myndhyve.color' })).toEqual({ key: 'x', type: 'text', declaredType: 'vendor.myndhyve.color' });
    expect(wireFieldToHost({ id: 'y', type: 'x-fancy' })).toEqual({ key: 'y', type: 'text', declaredType: 'x-fancy' });
  });

  it('degrades portable kinds the host has no control for', () => {
    for (const t of ['multiselect', 'file', 'artifact-ref']) {
      expect(wireFieldToHost({ id: 'z', type: t }).type, `${t} should degrade`).toBe('text');
    }
  });

  // THE WIRING TEST. Everything above calls `wireFieldToHost` directly, which
  // proves the mechanism and NOTHING about whether the loader invokes it — the
  // function was in fact defined and never called when first written, and all
  // of those assertions still passed. This goes through the real load path.
  it('the LOADER applies the translation — not just the exported function', () => {
    _resetFormContentRegistryForTest();
    const out = loadFormContentPacks({
      roots: [packRoot([{
        templateId: 'vendor.test.form.wire', version: '1.0.0', label: 'W', title: 'W',
        fields: [
          { id: 'note', label: 'Note', type: 'longtext' },
          { id: 'optin', label: 'Opt in', type: 'boolean' },
          { id: 'mail', label: 'Mail', type: 'text', format: 'email' },
          { id: 'party', label: 'Party', type: 'number' },
        ],
      }])],
    });
    expect(out.errors).toEqual([]);
    const t = getFormTemplate('vendor.test.form.wire');
    expect(t, 'template must register').not.toBeNull();
    expect(t!.fields.map((f) => f.type)).toEqual(['textarea', 'checkbox', 'email', 'number']);
    // `id` became `key` on the way through — storage keeps `key`.
    expect(t!.fields.map((f) => f.key)).toEqual(['note', 'optin', 'mail', 'party']);
  });

  it('the LOADER degrades a vendor extension instead of refusing the pack', () => {
    _resetFormContentRegistryForTest();
    const out = loadFormContentPacks({
      roots: [packRoot([{
        templateId: 'vendor.test.form.ext', version: '1.0.0', label: 'E', title: 'E',
        fields: [{ id: 'c', label: 'C', type: 'vendor.myndhyve.color' }],
      }])],
    });
    expect(out.errors, 'an extension type must NOT fail the pack').toEqual([]);
    const field = getFormTemplate('vendor.test.form.ext')!.fields[0]!;
    expect(field.type).toBe('text');
    // The declared wire type survives — the DEGRADE contract, not a silent rewrite.
    expect(field.declaredType).toBe('vendor.myndhyve.color');
  });

  it('the LOADER still REFUSES a bare unknown type — a typo is not an extension', () => {
    _resetFormContentRegistryForTest();
    const out = loadFormContentPacks({
      roots: [packRoot([{
        templateId: 'vendor.test.form.typo', version: '1.0.0', label: 'T', title: 'T',
        fields: [{ id: 'x', label: 'X', type: 'emial' }],
      }])],
    });
    expect(getFormTemplate('vendor.test.form.typo')).toBeNull();
    expect(out.errors).toEqual([{
      pack: 'test.forms', code: 'form_content_pack_invalid',
      message: "vendor.test.form.typo: field 'x' has unknown type 'emial' (allowed: text, longtext, number, boolean, select, multiselect, file, artifact-ref, or a vendor.*/x- extension)",
    }]);
  });
});

/**
 * RFC 0137 — the loader must not be LOOSER than the wire.
 *
 * It was, on three counts: `templateId` (no reserved-scope requirement),
 * `version` (any non-empty string vs SemVer), and field `id`. That is the
 * dangerous direction — a pack the host happily loads gets REJECTED at publish,
 * so the author learns it from a registry CI failure instead of from the loader.
 */
describe('RFC 0137 — loader patterns match the wire schema', () => {
  const packRootFor = (t: Record<string, unknown>) => packRoot([t]);
  const tpl = (over: Record<string, unknown> = {}) => ({
    templateId: 'vendor.test.form.ok', version: '1.0.0', label: 'L', title: 'T',
    fields: [{ id: 'a', label: 'A', type: 'text' }], ...over,
  });

  it('REFUSES a templateId with no reserved scope', () => {
    _resetFormContentRegistryForTest();
    const out = loadFormContentPacks({ roots: [packRootFor(tpl({ templateId: 'forms.contact-us' }))] });
    // The exact id the shipped pack used before RFC 0137 — it would have failed
    // registry validation for a SECOND reason after the field-type remap.
    expect(getFormTemplate('forms.contact-us')).toBeNull();
    expect(out.errors).toEqual([{ pack: 'test.forms', code: 'form_content_pack_invalid', message: 'templateId must be an id slug' }]);
  });

  it('REFUSES a non-SemVer template version', () => {
    _resetFormContentRegistryForTest();
    const out = loadFormContentPacks({ roots: [packRootFor(tpl({ version: 'v1' }))] });
    expect(getFormTemplate('vendor.test.form.ok')).toBeNull();
    expect(out.errors).toEqual([{ pack: 'test.forms', code: 'form_content_pack_invalid', message: 'vendor.test.form.ok: version must be SemVer' }]);
  });

  it('ACCEPTS a correctly scoped id and SemVer — the tightening must not over-fire', () => {
    _resetFormContentRegistryForTest();
    const out = loadFormContentPacks({ roots: [packRootFor(tpl())] });
    expect(out.errors).toEqual([]);
    expect(getFormTemplate('vendor.test.form.ok')).not.toBeNull();
  });
});
