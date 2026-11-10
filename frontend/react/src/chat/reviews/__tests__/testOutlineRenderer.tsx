/**
 * ADR 1031 P2 — a TEST-ONLY typed review renderer, so the generic review surfaces
 * (ReadableJson's envelope layout, gate evidence, the workbench fallback) are
 * tested against a fixture type instead of a product's (they used KickTodo's
 * `kicktodo.challenge-plan`, which now lives in the kicktodo-studio package and
 * moves downstream). Import for its side effect.
 */
import { registerReviewArtifactRenderer, type ReviewArtifactRendererProps } from '../reviewArtifactRenderers.js';

interface Outline { title?: unknown; days?: unknown }
const parse = (c: string | undefined): Outline | null => { try { const v = JSON.parse(c ?? '') as unknown; return v && typeof v === 'object' ? (v as Outline) : null; } catch { return null; } };
const days = (o: Outline | null): Array<{ day: number; title: string }> =>
  Array.isArray(o?.days) ? o.days.flatMap((d) => (d && typeof d === 'object' && typeof (d as { day?: unknown }).day === 'number' ? [{ day: (d as { day: number }).day, title: String((d as { title?: unknown }).title ?? '') }] : [])) : [];

function TestOutline({ asset }: ReviewArtifactRendererProps): JSX.Element {
  const o = parse(asset.content);
  return (
    <div>
      <h3>{typeof o?.title === 'string' ? o.title : ''}</h3>
      <ul>{days(o).map((d) => <li key={d.day}>{`Day ${d.day}: ${d.title}`}</li>)}</ul>
    </div>
  );
}

export const TEST_OUTLINE_TYPE = 'test.outline';
export const TEST_NO_MATCHER_TYPE = 'test.no-matcher';

registerReviewArtifactRenderer(TEST_OUTLINE_TYPE, TestOutline, {
  matches: (c) => { const o = parse(c); return typeof o?.title === 'string' && o.title.length > 0 && days(o).length > 0; },
});
registerReviewArtifactRenderer(TEST_NO_MATCHER_TYPE, TestOutline);
