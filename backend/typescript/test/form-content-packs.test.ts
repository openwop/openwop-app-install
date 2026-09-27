/**
 * ADR 0516 — form-content packs: the loader's bounded validation and the
 * instantiate-through-createForm rule.
 *
 * A form template defines a PUBLIC, unauthenticated submission surface
 * (`/public-forms/:formId`), so the safety story has two halves and NEITHER is
 * sufficient alone:
 *   - the LOADER caps and shape-checks at load time (it cannot know what a field
 *     means, but it can refuse 10,000 of them);
 *   - `createForm` sanitizes at instantiation (it cannot know a pack shipped a
 *     hostile count, but it knows what a field may contain).
 * These test the loader half plus the wiring that guarantees the second half runs.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadFormContentPacks,
  reloadFormContentPacks,
  listFormTemplates,
  getFormTemplate,
  _resetFormContentRegistryForTest,
} from '../src/host/formContentPackLoader.js';
import { WIRE_TYPES, WIRE_TO_HOST } from '../src/host/formContentPackLoader.js';

const dirs: string[] = [];
function packRoot(manifest: unknown, packDir = 'test.forms'): string {
  const root = mkdtempSync(join(tmpdir(), 'form-content-'));
  dirs.push(root);
  mkdirSync(join(root, packDir), { recursive: true });
  writeFileSync(join(root, packDir, 'pack.json'), JSON.stringify(manifest), 'utf8');
  return root;
}
const validTemplate = (over: Record<string, unknown> = {}) => ({
  templateId: 'vendor.test.form.one', version: '1.0.0', label: 'One', title: 'One',
  fields: [{ id: 'name', label: 'Name', type: 'text' }],
  ...over,
});
const manifest = (templates: unknown[]) => ({ name: 'test.forms', version: '1.0.0', kind: 'form-content', templates });

afterEach(() => {
  _resetFormContentRegistryForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ADR 0516 — form-content pack loader', () => {
  it('registers a valid template and exposes it by id', () => {
    const out = loadFormContentPacks({ roots: [packRoot(manifest([validTemplate()]))] });
    expect(out.errors).toEqual([]);
    expect(out.installed[0]?.templateIds).toEqual(['vendor.test.form.one']);
    expect(getFormTemplate('vendor.test.form.one')?.title).toBe('One');
  });

  it('kind-filters: a pack of another kind is IGNORED, not an error', () => {
    // The whole no-RFC argument rests on this. An unrecognized kind must be skipped
    // silently — if it errored, a host would "fail" on packs meant for someone else.
    const out = loadFormContentPacks({
      roots: [packRoot({ name: 'x', version: '1.0.0', kind: 'canvas-content', kits: [] })],
    });
    expect(out.errors).toEqual([]);
    expect(out.installed).toEqual([]);
  });

  it('REJECTS a template declaring an intakeBinding — invariant form-content-template-no-submission-routing', () => {
    // RFC 0137 §F2 (protocol-tier invariant). The ban constrains the PACK, not
    // the host: an operator may route wherever they configure — my own
    // `intakeBinding` → `submit-idea` path is host routing and stays legal. What
    // a pack may never do is DECLARE a destination.
    // Rejected outright rather than stripped: a template that tried to route an
    // operator's submissions is one whose intent needs review.
    const out = loadFormContentPacks({
      roots: [packRoot(manifest([validTemplate({ intakeBinding: { listId: 'list-1', titleField: 'name' } })]))],
    });
    expect(listFormTemplates()).toEqual([]);
    expect(out.errors[0]?.message).toContain('intakeBinding');
  });

  it('never DERIVES a destination from pack-authored content — the invariant\'s second arm', () => {
    // RFC 0137 §F2: a destination must be chosen by the operator and never
    // derived from pack content. `category` is a grouping HINT for the picker,
    // not a routing key — a host that quietly routed by it would satisfy the
    // literal ban while breaking its intent.
    _resetFormContentRegistryForTest();
    const out = loadFormContentPacks({
      roots: [packRoot(manifest([validTemplate({ category: 'list-1' })]))],
    });
    expect(out.errors).toEqual([]);
    const t = getFormTemplate('vendor.test.form.one');
    expect(t?.category).toBe('list-1');
    // Registered with the hint, and with NO routing anywhere on it.
    expect((t as unknown as Record<string, unknown>).intakeBinding).toBeUndefined();
  });

  it('caps fields per template — a hostile count cannot reach the public form page', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `f${i}`, label: `F${i}`, type: 'text' }));
    const out = loadFormContentPacks({ roots: [packRoot(manifest([validTemplate({ fields: many })]))] });
    expect(listFormTemplates()).toEqual([]);
    expect(out.errors[0]?.message).toMatch(/fields must be 1\.\.50/);
  });

  it('caps templates per pack', () => {
    const many = Array.from({ length: 21 }, (_, i) => validTemplate({ templateId: `t.${i}` }));
    const out = loadFormContentPacks({ roots: [packRoot(manifest(many))] });
    expect(listFormTemplates()).toEqual([]);
    expect(out.errors[0]?.message).toMatch(/at most 20 templates/);
  });

  it('REFUSES what the service would silently truncate — options, label, title', () => {
    // A pack is authored ahead of time by someone who can fix it, so silent
    // truncation there just lies to the template author. The service truncates
    // (a live form must keep saving); the LOADER refuses, while it is still cheap.
    const tooManyOpts = Array.from({ length: 251 }, (_, i) => `o${i}`);
    expect(loadFormContentPacks({ roots: [packRoot(manifest([validTemplate({
      fields: [{ id: 'k', label: 'K', type: 'select', options: tooManyOpts }],
    })]))] }).errors[0]?.message).toContain('at most 250 options');
    _resetFormContentRegistryForTest();

    expect(loadFormContentPacks({ roots: [packRoot(manifest([validTemplate({
      fields: [{ id: 'k', label: 'x'.repeat(1_001), type: 'text' }],
    })]))] }).errors[0]?.message).toContain('label must be <= 1000');
    _resetFormContentRegistryForTest();

    expect(loadFormContentPacks({ roots: [packRoot(manifest([validTemplate({
      title: 't'.repeat(201),
    })]))] }).errors[0]?.message).toContain('title must be <= 200');
    _resetFormContentRegistryForTest();

    // …and the LEGITIMATE maximum still loads. Without this, capping everything to
    // zero would satisfy the three refusals above.
    const countries = Array.from({ length: 195 }, (_, i) => `Country ${i}`);
    const ok = loadFormContentPacks({ roots: [packRoot(manifest([validTemplate({
      fields: [{ id: 'country', label: 'Country', type: 'select', options: countries }],
    })]))] });
    expect(ok.errors).toEqual([]);
    expect(listFormTemplates()).toHaveLength(1);
  });

  it('REFUSES a second pack claiming an already-registered templateId — grade-data FT-DATA-2', () => {
    // The third-party shadowing defense. Once packs.openwop.dev carries templates
    // the operator did not author, a hostile pack that redefines `forms.contact-us`
    // would silently replace a trusted form's fields on the next boot. First
    // registrant wins and the loser is REPORTED — a silent overwrite here is the
    // whole attack.
    const mine = packRoot(manifest([validTemplate({ title: 'Mine' })]), 'first.forms');
    const theirs = packRoot(
      { name: 'second.forms', version: '2.0.0', kind: 'form-content', templates: [validTemplate({ title: 'Theirs' })] },
      'second.forms',
    );
    const out = loadFormContentPacks({ roots: [mine, theirs] });
    expect(getFormTemplate('vendor.test.form.one')?.title).toBe('Mine');
    const conflict = out.errors.find((e) => e.code === 'form_content_template_conflict');
    expect(conflict, `expected a conflict error, got ${JSON.stringify(out.errors)}`).toBeTruthy();
    expect(conflict?.message).toContain('vendor.test.form.one');
    // The conflict must not be reported as a successful install of the loser.
    expect(out.installed.find((i) => i.packName === 'second.forms')).toBeUndefined();
  });

  it('allows a pack to RE-register its own templateId (a reload is not a conflict)', () => {
    // Guards the check above from over-firing: `existing.packName !== packName`
    // is what makes a version bump of the SAME pack legal. Without this case a
    // stricter "any duplicate is a conflict" bug would look identical.
    const root = packRoot(manifest([validTemplate()]));
    loadFormContentPacks({ roots: [root] });
    const out = loadFormContentPacks({ roots: [root] });
    expect(out.errors).toEqual([]);
    expect(out.installed[0]?.templateIds).toEqual(['vendor.test.form.one']);
  });

  it('REFUSES an out-of-catalog field type — the service would silently coerce it to text', () => {
    // 'radio' is the sharpest case, not an arbitrary one: `sanitizeFields`
    // attaches `options` ONLY for 'select', so coercing to 'text' drops them
    // entirely and a closed choice set becomes an unconstrained free-text box
    // on a PUBLIC page. Refusing names the offending value so the author can
    // fix it; coercing would have shipped a semantically different form.
    const out = loadFormContentPacks({
      roots: [packRoot(manifest([validTemplate({
        fields: [{ id: 'choice', label: 'Pick one', type: 'radio', options: ['Yes', 'No'] }],
      })]))],
    });
    expect(getFormTemplate('vendor.test.form.one')).toBeNull();
    expect(JSON.stringify(out.errors)).toContain('radio');
    expect(JSON.stringify(out.errors)).toContain('unknown type');
  });

  it('accepts every type the service actually honours — the refusal must not over-fire', () => {
    // Guards the check above from being a blanket reject. Without this, a bug
    // that refused ALL types would look identical to a correct catalog check.
    const fields = WIRE_TYPES.map((t, i) => ({
      id: `f${i}`, label: `Field ${i}`, type: t, ...(t === 'select' || t === 'multiselect' ? { options: ['a', 'b'] } : {}),
    }));
    const out = loadFormContentPacks({ roots: [packRoot(manifest([validTemplate({ fields })]))] });
    expect(out.errors).toEqual([]);
    // Registered as HOST types — the loader translates at the boundary.
    expect(getFormTemplate('vendor.test.form.one')?.fields.map((f) => f.type)).toEqual(WIRE_TYPES.map((t) => WIRE_TO_HOST[t]));
  });

  it('REFUSES a non-boolean `required` — the service reads it as false', () => {
    // Milder than the type case but the same family: the author declares a
    // field required, the service reads `f.required === true`, and the string
    // "true" quietly makes it optional. Incomplete data, no signal.
    const out = loadFormContentPacks({
      roots: [packRoot(manifest([validTemplate({
        fields: [{ id: 'name', label: 'Name', type: 'text', required: 'true' }],
      })]))],
    });
    expect(getFormTemplate('vendor.test.form.one')).toBeNull();
    expect(JSON.stringify(out.errors)).toContain('required must be a boolean');
  });

  it('REFUSES an unbounded template label/description/category — grade-code GC-1', () => {
    // The THIRD member of the advertised-vs-enforced family, and the one the
    // Phase 2a enumeration missed because it stopped at FormTemplateField.
    // These never become a FormDef, so `sanitizeFields` never sees them —
    // `listFormTemplates()` hands the whole template to the catalog route and
    // the picker renders it. Unbounded here is unbounded all the way to the
    // browser, with NO second layer to catch it.
    for (const [field, over] of [
      ['label', { label: 'L'.repeat(201) }],
      ['description', { description: 'D'.repeat(301) }],
      ['category', { category: 'C'.repeat(65) }],
    ] as const) {
      _resetFormContentRegistryForTest();
      const out = loadFormContentPacks({ roots: [packRoot(manifest([validTemplate(over)]))] });
      expect(getFormTemplate('vendor.test.form.one'), `${field} should have been refused`).toBeNull();
      expect(JSON.stringify(out.errors)).toContain(field);
    }
  });

  it('accepts ordinary template display strings — the bound must not over-fire', () => {
    // Guards the check above from rejecting realistic content: a blanket refusal
    // would look identical to a correct bound.
    const out = loadFormContentPacks({ roots: [packRoot(manifest([validTemplate({
      label: 'Job application', description: 'Collect applications for an open role.', category: 'hr',
    })]))] });
    expect(out.errors).toEqual([]);
    expect(getFormTemplate('vendor.test.form.one')?.label).toBe('Job application');
  });

  it('rejects a duplicate field id — it would silently overwrite a submitted value', () => {
    const out = loadFormContentPacks({
      roots: [packRoot(manifest([validTemplate({
        fields: [{ id: 'name', label: 'A', type: 'text' }, { id: 'name', label: 'B', type: 'text' }],
      })]))],
    });
    expect(listFormTemplates()).toEqual([]);
    expect(out.errors[0]?.message).toContain('duplicate field id');
  });

  it('rejects a field id that is not payload-safe (the RFC 0124 lesson)', () => {
    const out = loadFormContentPacks({
      roots: [packRoot(manifest([validTemplate({ fields: [{ id: 'not-safe!', label: 'X', type: 'text' }] })]))],
    });
    expect(listFormTemplates()).toEqual([]);
    expect(out.errors[0]?.message).toContain('field ids must match');
  });

  it('an unreadable pack is an ERROR, never a silent skip', () => {
    const root = mkdtempSync(join(tmpdir(), 'form-content-bad-'));
    dirs.push(root);
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'pack.json'), '{ not json', 'utf8');
    const out = loadFormContentPacks({ roots: [root] });
    expect(out.errors[0]?.code).toBe('form_content_pack_unreadable');
  });

  it('reload CLEARS — a template removed from a still-present pack does not survive', () => {
    const root = packRoot(manifest([validTemplate(), validTemplate({ templateId: 'vendor.test.form.two' })]));
    loadFormContentPacks({ roots: [root] });
    expect(listFormTemplates()).toHaveLength(2);
    // Rewrite the pack with one template removed, then reload.
    writeFileSync(join(root, 'test.forms', 'pack.json'), JSON.stringify(manifest([validTemplate()])), 'utf8');
    reloadFormContentPacks({ roots: [root] });
    expect(listFormTemplates().map((t) => t.templateId)).toEqual(['vendor.test.form.one']);
  });

  it('the shipped starter pack loads and carries no intakeBinding', () => {
    // The in-tree pack is real cargo, not a fixture — if it ever violated its own
    // rules the loader would drop it and the picker would silently be empty.
    const out = loadFormContentPacks({ roots: [defaultRepoPacksDir()] });
    const starters = out.installed.find((p) => p.packName === 'core.openwop.forms.starters');
    expect(starters, `starters pack must load; errors: ${JSON.stringify(out.errors)}`).toBeTruthy();
    expect(starters!.templateIds).toContain('core.openwop.form.contact-us');
    // Assert against the SHIPPED pack.json, not the parsed registry: the loader
    // would have rejected a template declaring one, so checking the loaded objects
    // could pass merely because the offender was dropped.
    const raw = JSON.parse(readFileSync(join(defaultRepoPacksDir(), 'core.openwop.forms.starters', 'pack.json'), 'utf8')) as { templates: Record<string, unknown>[] };
    for (const t of raw.templates) {
      expect(t.intakeBinding, `${String(t.templateId)} must not route submissions`).toBeUndefined();
      // The shipped manifest speaks the WIRE vocabulary (RFC 0137). Read the RAW
      // manifest, not the registry: the registry holds TRANSLATED host types, so
      // a wire-catalog check against loaded objects would pass vacuously. This
      // ratchet caught `type:"number"` shipping when it did not exist.
      for (const f of (t.fields as Record<string, unknown>[])) {
        expect(
          WIRE_TYPES as readonly string[],
          `${String(t.templateId)}.${String(f.id)} declares type '${String(f.type)}', which the service would silently coerce to 'text'`,
        ).toContain(f.type);
        if (f.required !== undefined) {
          expect(
            typeof f.required,
            `${String(t.templateId)}.${String(f.id)} required must be a boolean — the service reads a non-boolean as false`,
          ).toBe('boolean');
        }
      }
    }
  });
});

/** The repo `packs/` dir, resolved from this test file. */
function defaultRepoPacksDir(): string {
  return new URL('../../../packs/', import.meta.url).pathname;
}
