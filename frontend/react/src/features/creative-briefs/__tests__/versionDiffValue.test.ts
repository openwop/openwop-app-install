/**
 * CB82UX-4 (ADR 1039 P3) — the version diff shows values as a person reads them.
 * Before: every changed field printed `JSON.stringify(from) → JSON.stringify(to)`,
 * so a direction change read as `[{"label":"A","rationale":"…"}]` and a mood board
 * as a list of `masset:` ids.
 *
 * Red when a structured value falls back to raw JSON, an empty value stops reading
 * "—", a mood board prints asset ids instead of a count, or an edit whose readable
 * form is unchanged (a rationale-only edit) reads as "A → A".
 */
import { describe, expect, it } from 'vitest';
import { diffLine, diffValue } from '../CreativeBriefsPage.js';

const t = ((key: string, opts?: Record<string, unknown>) => `${key}:${JSON.stringify(opts ?? {})}`) as unknown as Parameters<typeof diffValue>[0];

describe('CB82UX-4 — version diff values', () => {
  it('reads text, lists, directions, the mood board and the platform spec without JSON', () => {
    expect(diffValue(t, 'title', 'Spring hero')).toBe('Spring hero');
    expect(diffValue(t, 'brandPalette', ['#112233', '#445566'])).toBe('#112233, #445566');
    expect(diffValue(t, 'directions', [{ label: 'Product in use', rationale: 'r' }, { label: 'Before / after' }])).toBe('Product in use · Before / after');
    expect(diffValue(t, 'moodBoard', [{ mediaAssetId: 'masset:1' }, { mediaAssetId: 'masset:2' }])).toBe('diffMoodBoardCount:{"count":2}');
    expect(diffValue(t, 'platformSpec', { platform: 'meta', format: 'feed', textRulePct: 20 })).toBe('meta · feed · diffTextRule:{"pct":20}');
    for (const empty of [undefined, null, '', []]) expect(diffValue(t, 'directions', empty)).toBe('—');
    expect(diffValue(t, 'platformSpec', {})).toBe('—');
  });

  it('an edit the readable form cannot show still reads as edited, never "A → A"', () => {
    const from = [{ label: 'A', rationale: 'old' }];
    const to = [{ label: 'A', rationale: 'new' }];
    expect(diffLine(t, 'directions', from, to)).toBe('diffEditedDetail:{"value":"A"}');
    expect(diffLine(t, 'title', 'Old', 'New')).toBe('Old → New');
    expect(diffValue(t, 'somethingNew', { a: 1 })).toBe('diffEditedValue:{}');
  });
});
