/**
 * ADR 0516 — the form-content LOADER's caps and the forms SERVICE's caps are the
 * same numbers, and this test is what keeps them that way.
 *
 * They are duplicated, not shared: `host/formContentPackLoader.ts` must not take a
 * host→feature edge into `features/forms/`, so it restates the bounds. Duplication
 * without a binding test is drift waiting to happen — and the drift is not
 * cosmetic:
 *
 *   - loader LOOSER than the service ⇒ a template author ships 300 options, the
 *     loader accepts, and the service silently drops 50. The pack is lying to its
 *     author, and nothing surfaces it.
 *   - loader STRICTER than the service ⇒ the loader refuses templates the product
 *     would happily accept from a user typing the same thing by hand.
 *
 * That asymmetry is exactly the defect this feature already hit once: the loader
 * capped fields at 40 while the service capped at 50.
 *
 * The test reads the SOURCE of both files rather than importing the loader's
 * private constants — the point is to pin the two literals together, and a
 * constant a test can import is one the loader would have had to export purely for
 * the test's benefit.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');

/** `const NAME = 1_000;` → 1000. Underscore separators are the repo's style. */
function constOf(src: string, name: string): number | null {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`).exec(src);
  return m ? Number(m[1]!.replace(/_/g, '')) : null;
}

const LOADER = read('../src/host/formContentPackLoader.ts');
const SERVICE = read('../src/features/forms/formsService.ts');
/** The EDITOR's mirror of the same numbers. Reaching across the workspace
 *  boundary is deliberate: the frontend is a separate build and cannot import a
 *  backend constant, so `CAPS` was a THIRD hand-written list with nothing
 *  checking it — and a hand-written test asserting hand-written literals only
 *  proves two lists agree with each other, not that either matches the server. */
const CLIENT_PATH = '../../../frontend/react/src/features/forms/formsClient.ts';
const EDITOR_PATH = '../../../frontend/react/src/features/forms/FormDetailPage.tsx';
/** Read TOLERANTLY. This was a bare `read()` at module scope, which meant a
 *  missing or relocated frontend file threw at IMPORT and took down the whole
 *  file — including the loader↔service cases above, which have nothing to do
 *  with the frontend. A backend-only invariant must not be collateral damage
 *  from the other workspace's layout.
 *
 *  Deliberately NOT a silent skip: `null` makes the frontend cases below fail
 *  with the path in the message, so the gate cannot quietly stop protecting. */
const EDITOR = ((): string | null => {
  try { return read(EDITOR_PATH); } catch { return null; }
})();
const CLIENT = ((): string | null => {
  try { return read(CLIENT_PATH); } catch { return null; }
})();

/** `FIELD_TYPES: readonly FieldType[] = ['text', …]` → the string list. */
function fieldTypesOf(src: string | null): string[] | null {
  if (src === null) return null;
  const m = /FIELD_TYPES[^=]*=\s*\[([^\]]*)\]/.exec(src);
  return m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!) : null;
}

/** `title: 200` inside the `CAPS` object literal. */
function capOf(src: string | null, name: string): number | null {
  if (src === null) return null;
  const obj = /const CAPS = \{([^}]*)\}/.exec(src);
  if (!obj) return null;
  const m = new RegExp(`${name}\\s*:\\s*([0-9_]+)`).exec(obj[1]!);
  return m ? Number(m[1]!.replace(/_/g, '')) : null;
}

describe('ADR 0516 — loader and service caps are one set of numbers', () => {
  it.each([
    ['MAX_LABEL', 'MAX_LABEL'],
    ['MAX_TITLE', 'MAX_TITLE'],
    ['MAX_OPTIONS', 'MAX_OPTIONS'],
    ['MAX_OPTION_LEN', 'MAX_OPTION_LEN'],
    ['MAX_FIELDS_PER_TEMPLATE', 'MAX_FIELDS'],
  ])('%s (loader) === %s (service)', (loaderName, serviceName) => {
    const l = constOf(LOADER, loaderName);
    const s = constOf(SERVICE, serviceName);
    // Both must EXIST — a renamed constant that silently reads null on both sides
    // would make this assertion `null === null` and pass forever.
    expect(l, `loader is missing ${loaderName}`).not.toBeNull();
    expect(s, `service is missing ${serviceName}`).not.toBeNull();
    expect(l, `${loaderName} (loader) drifted from ${serviceName} (service)`).toBe(s);
  });

  // grade-code GC-2 — the editor is the THIRD copy of these numbers. Without
  // this, a server-side cap change leaves the editor silently permissive and the
  // save truncates: exactly the succeeds-but-wrong failure FT-UX-2 shipped.
  it.each([
    ['title', 'MAX_TITLE'],
    ['label', 'MAX_LABEL'],
    ['submitMessage', 'MAX_SUBMIT_MESSAGE'],
    ['description', 'MAX_DESCRIPTION'],
  ])('CAPS.%s (editor) === %s (service)', (capName, serviceName) => {
    expect(EDITOR, `could not read ${EDITOR_PATH} — the editor cap gate cannot run`).not.toBeNull();
    const c = capOf(EDITOR, capName);
    const s = constOf(SERVICE, serviceName);
    expect(c, `editor CAPS is missing ${capName}`).not.toBeNull();
    expect(s, `service is missing ${serviceName}`).not.toBeNull();
    expect(c, `CAPS.${capName} (editor) drifted from ${serviceName} (service)`).toBe(s);
  });

  it('the CAPS extractor actually parses the editor (anti-vacuity)', () => {
    // Same guard as below: a regex matching nothing would make every CAPS
    // assertion compare null to null.
    expect(capOf('const CAPS = { title: 200, label: 1_000 } as const;', 'label')).toBe(1000);
    expect(capOf(EDITOR, 'title')).not.toBeNull();
  });

  // /architect finding — the field catalog has a THIRD copy (`formsClient.ts`)
  // that no gate held. The caps had a parity gate; the catalog that decides how
  // a public form renders did not. A catalog change must move both, and until
  // now nothing would have caught the drift.
  it('FIELD_TYPES (editor client) === FIELD_TYPES (service)', () => {
    const c = fieldTypesOf(CLIENT);
    const s = fieldTypesOf(SERVICE);
    expect(c, `could not parse FIELD_TYPES from ${CLIENT_PATH}`).not.toBeNull();
    expect(s, 'could not parse FIELD_TYPES from the service').not.toBeNull();
    expect(c, 'the frontend field catalog drifted from the service').toEqual(s);
  });

  it('the FIELD_TYPES extractor actually parses (anti-vacuity)', () => {
    expect(fieldTypesOf("const FIELD_TYPES: readonly FieldType[] = ['a', 'b'];")).toEqual(['a', 'b']);
    expect(fieldTypesOf(SERVICE)).toContain('text');
  });

  it('the extractor actually parses these files (anti-vacuity)', () => {
    // A regex that matched nothing would make every assertion above vacuously
    // compare null to null — which the not-toBeNull guards catch, but only if the
    // extractor works at all. Prove it on a known value.
    expect(constOf(LOADER, 'MAX_TEMPLATES_PER_PACK')).toBe(20);
    expect(constOf('const X = 1_234;', 'X')).toBe(1234);
    expect(constOf('const Y = 5;', 'NOPE')).toBeNull();
  });
});
