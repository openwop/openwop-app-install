/**
 * ADR 1100 D3 — the projector finds pictures by FIELD NAME (`CMS_IMAGE_TOKEN_KEYS`),
 * so its coverage is only as good as the claim that every renderer reads a
 * picture from one of those names. This pins that claim against the renderers'
 * own source: the public React renderer, the design sections, and the backend
 * crawler HTML.
 *
 * Red when a renderer reads a picture through a new field name (say
 * `posterToken`) that the projector would not see, so its alt would go
 * unchecked. Add the name to `CMS_IMAGE_TOKEN_KEYS` (and the Reviewer prompt; a
 * backend test pins that) rather than to an allow-list here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CMS_IMAGE_TOKEN_KEYS } from '../cmsA11y.js';

const CMS = join(__dirname, '..');
const BACKEND_HTML = join(__dirname, '..', '..', '..', '..', '..', '..', 'backend', 'typescript', 'src', 'features', 'publishing', 'sectionHtml.ts');

/** Every `<obj>.<field>` a renderer turns into an image URL or a picture. */
function imageFieldsIn(src: string): string[] {
  const out: string[] = [];
  for (const re of [
    /assetUrl\(str\(\w+\.(\w+)\)\)/g, // FE: assetUrl(str(d.imageToken))
    /ColumnShot token=\{str\(\w+\.(\w+)\)\}/g, // FE: <ColumnShot token={str(c.imageToken)} …>
    /assetUrl\([\w.]+,\s*str\(\w+\.(\w+)\)\)/g, // backend: assetUrl(opts.assetBase, str(d.imageToken))
  ]) for (const m of src.matchAll(re)) out.push(m[1]!);
  return out;
}

describe('CMS renderers read pictures only through the projector\'s field names', () => {
  for (const [label, path] of [
    ['SectionRenderer.tsx', join(CMS, 'SectionRenderer.tsx')],
    ['DesignSections.tsx', join(CMS, 'DesignSections.tsx')],
    ['publishing/sectionHtml.ts', BACKEND_HTML],
  ] as const) {
    it(label, () => {
      const fields = imageFieldsIn(readFileSync(path, 'utf8'));
      expect(fields.length, `no picture reads found in ${label}: the scan would be vacuous`).toBeGreaterThan(0);
      const keys: readonly string[] = CMS_IMAGE_TOKEN_KEYS;
      expect([...new Set(fields.filter((f) => !keys.includes(f)))]).toEqual([]);
    });
  }
});
