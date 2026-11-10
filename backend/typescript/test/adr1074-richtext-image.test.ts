/**
 * ADR 1074 — server half of the richText screenshot (`visual: 'image'`).
 *
 *   - the validator keeps imageToken, alt, frameUrl and caption, and refuses a
 *     token without alt;
 *   - crawlers and markdown get the picture only while it is the visual shown
 *     (ADR 0593 §C9): a switched-away image stays stored but is not served.
 *
 * Sabotage witnesses: dropping `image` from the visual set, dropping the alt
 * refusal or a field, or serving the picture without the visual gate reds a
 * case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const OPTS = { assetBase: 'https://app.example.test' };
const rt = (data: Record<string, unknown>) => validateSection({ type: 'richText', data: { heading: 'An example', text: 'The essay.', ...data } });
const SHOT = { imageToken: 'tok-approval', alt: 'The approval screen', frameUrl: 'Approval · waiting for you', caption: 'Nothing goes out until you say so.' };

describe('richText screenshot (ADR 1074 D1)', () => {
  it('keeps the screenshot fields and refuses a token without alt', () => {
    expect(rt({ visual: 'image', ...SHOT }).data).toMatchObject({ visual: 'image', ...SHOT });
    expect(() => rt({ visual: 'image', imageToken: 'tok-approval' })).toThrow(/alt is required/);
  });

  it('serves the picture after the essay only while it is the visual shown', () => {
    const on = rt({ visual: 'image', ...SHOT });
    expect(sectionHtml(on, OPTS)).toMatch(/<p>The essay\.<\/p>\n<figure>\n<img src="[^"]*tok-approval" alt="The approval screen">\n<figcaption>Nothing goes out until you say so\.<\/figcaption>\n<\/figure>\n<\/section>$/);
    expect(sectionMarkdown(on, OPTS.assetBase)).toMatch(/The essay\.\n\n!\[The approval screen\]\([^)]*tok-approval\)\n\n\*Nothing goes out until you say so\.\*$/);
    const off = rt({ visual: 'chat', ...SHOT });
    expect(off.data.imageToken, 'kept for switching back').toBe('tok-approval');
    expect(sectionHtml(off, OPTS)).not.toContain('tok-approval');
    expect(sectionMarkdown(off, OPTS.assetBase)).not.toContain('tok-approval');
  });
});
