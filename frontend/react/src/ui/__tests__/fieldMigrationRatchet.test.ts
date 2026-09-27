/**
 * The `ui/Field` migration ratchet.
 *
 * Seven feature screens hand-rolled `<label>…<input>` instead of using the
 * shared primitive. Each per-feature UX pass deferred it rather than doing a
 * partial migration, and they were then swept together — the whole point being
 * that a sweep is worth doing ONCE. This guard keeps them swept.
 *
 * Deliberately scoped to the migrated features, not the whole app: plenty of
 * other screens still hand-roll, and pretending otherwise would make this a
 * false claim about the codebase. Add a feature here when it is migrated.
 *
 * `Field`'s own docblock explains why this matters: it exists because "every
 * hand-rolled `<label>…<input>` in the app was getting [the a11y wiring] wrong
 * (jsx-a11y/label-has-associated-control)" — a generated id, an explicit
 * label↔control association, `aria-describedby` for help and error text, and
 * `aria-invalid` in an error state.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Resolved from the vitest root (frontend/react), not `import.meta.url` — under
// vitest that URL is not a real file path and resolved to a bogus `/src/...`.
const FEATURES_DIR = join(process.cwd(), 'src', 'features');

/** Features whose forms have been migrated to `ui/Field`. */
const MIGRATED = [
  'creative-briefs',
  'campaign-intel',
  'campaign-connectors',
  'webinars',
  'product-discovery',
  'recommendations',
  'promotions',
  'creative-video',
] as const;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue; // fixtures may build raw markup on purpose
      out.push(...tsxFiles(full));
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('ui/Field migration stays done', () => {
  for (const feature of MIGRATED) {
    it(`${feature} renders no hand-rolled <label>`, () => {
      const offenders = tsxFiles(join(FEATURES_DIR, feature))
        .filter((f) => /<label[\s>]/.test(readFileSync(f, 'utf8')))
        .map((f) => f.slice(FEATURES_DIR.length + 1));
      // A failure here is not "add an exemption" — it is "use TextField /
      // TextareaField / SelectField / CheckboxField, or <Field> with a render
      // prop for a custom control".
      expect(offenders).toEqual([]);
    });
  }

  it('resolves the features directory at all', () => {
    // Without this, a bad path would make every case above pass vacuously by
    // finding no files to check.
    expect(existsSync(FEATURES_DIR)).toBe(true);
    expect(tsxFiles(join(FEATURES_DIR, 'promotions')).length).toBeGreaterThan(0);
  });

  it('the migrated list names real feature directories', () => {
    // Guards the guard: a renamed or deleted feature must not silently stop
    // being checked.
    const present = new Set(readdirSync(FEATURES_DIR));
    expect(MIGRATED.filter((f) => !present.has(f))).toEqual([]);
  });
});
