/**
 * challenge-outline coercion tests (ADR 0458 §2.3) — the working-draft doc is
 * narrowed from opaque canvas state with safe fallbacks (never `as unknown as`),
 * always yielding exactly one editable 'outline' frame so the tree surface is
 * never blank. Determinism (stable ids preserved, re-coercion idempotent) is the
 * property that keeps the collab CRDT from id-churn wars.
 */
import { describe, expect, it } from 'vitest';
import { coerceOutlineDoc, outlineFrameOps, OUTLINE_FRAME_ID } from '../types.js';
import { challengeOutlineDefinition } from '../definition.js';

describe('coerceOutlineDoc', () => {
  it('narrows a full plan projection, preserving stable ids', () => {
    const doc = coerceOutlineDoc({
      meta: { title: 'Sleep reset', promise: 'Sleep better', audience: 'busy adults', durationDays: 14, dailyMinutesBudget: 20, depthLevel: 'beginner' },
      outcomes: [{ outcomeId: 'o1', measurableOutcome: 'wake refreshed', method: 'diary' }],
      achievements: [{ achievementId: 'a1', observableEvidence: 'logged 7h', outcomeIds: ['o1'] }],
      frames: [{ id: 'outline', name: 'Outline', days: [
        { type: 'day', props: { day: 1, stableActivityId: 'd1', title: 'Wind down', actionInstruction: 'Dim lights', userFacingWhy: 'Melatonin', estimatedMinutes: 10, evidencePolicy: 'note', achievementIds: ['a1'], isRecovery: false }, children: [
          { type: 'alternative', props: { stableActivityId: 'd1-alt', title: 'Read', actionInstruction: 'Read a book', evidencePolicy: 'note' } },
        ] },
      ] }],
    });
    expect(doc.name).toBe('Sleep reset');            // derived from meta.title
    expect(doc.meta.depthLevel).toBe('beginner');
    expect(doc.outcomes[0]?.outcomeId).toBe('o1');
    expect(doc.frames).toHaveLength(1);
    expect(doc.frames[0]?.days[0]?.props.title).toBe('Wind down');
    expect(doc.frames[0]?.days[0]?.children[0]?.props.title).toBe('Read');
  });

  it('falls back safely on an empty/garbage state', () => {
    const doc = coerceOutlineDoc({});
    expect(doc.frames).toHaveLength(1);
    expect(doc.frames[0]?.id).toBe(OUTLINE_FRAME_ID);
    expect(doc.frames[0]?.days).toEqual([]);
    expect(doc.meta.durationDays).toBe(3);           // schema minimum
    expect(doc.meta.dailyMinutesBudget).toBe(5);
    expect(doc.name).toBe('Untitled challenge');
    expect(doc.outcomes).toEqual([]);
    expect(doc.achievements).toEqual([]);
  });

  it('clamps an unknown evidence policy and drops non-string achievementIds', () => {
    const doc = coerceOutlineDoc({
      frames: [{ days: [{ type: 'day', props: { title: 'x', evidencePolicy: 'telepathy', achievementIds: ['a1', 7, null] } }] }],
    });
    const day = doc.frames[0]?.days[0];
    expect(day?.props.evidencePolicy).toBe('attestation'); // unknown → safe default
    expect(day?.props.achievementIds).toEqual(['a1']);     // non-strings dropped
    expect(day?.props.day).toBe(1);                        // index-derived fallback
  });

  it('drops an invalid depthLevel rather than persisting garbage', () => {
    const doc = coerceOutlineDoc({ meta: { title: 'T', depthLevel: 'expert' } });
    expect(doc.meta.depthLevel).toBeUndefined();
  });

  it('re-coercing the same doc is idempotent (no id churn through the CRDT)', () => {
    const once = coerceOutlineDoc({ frames: [{ days: [{ type: 'day', props: { title: 'a' } }, { type: 'day', props: { title: 'b' } }] }] });
    const twice = coerceOutlineDoc(once as unknown as Record<string, unknown>);
    expect(twice.frames[0]?.days.map((d) => d.props.stableActivityId))
      .toEqual(once.frames[0]?.days.map((d) => d.props.stableActivityId));
  });
});

describe('challengeOutlineDefinition', () => {
  it('is a frames+tree type on the days/children keys, capped at one frame', () => {
    expect(challengeOutlineDefinition.canvasTypeId).toBe('canvas.challenge-outline');
    expect(challengeOutlineDefinition.frames.key).toBe('frames');
    expect(challengeOutlineDefinition.frames.max).toBe(1);
    expect(challengeOutlineDefinition.frames.homeFlag).toBeUndefined();
    expect(challengeOutlineDefinition.tree.rootKey).toBe('days');
    expect(challengeOutlineDefinition.tree.childrenKey).toBe('children');
    expect(challengeOutlineDefinition.collab).toBe('elements');
    expect(challengeOutlineDefinition.docNameKey).toBe('name');
  });

  it('the frames trait refuses a second frame (max 1)', () => {
    const doc = coerceOutlineDoc({});
    expect(outlineFrameOps.addFrame(doc, 'second')).toBe(-1);
  });
});
