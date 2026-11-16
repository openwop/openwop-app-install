/**
 * CC-BRIEF-2 — a brief's tone override and CTA strategy were cut to 160 characters
 * (NAME_MAX) on save, silently: a CasaVoga marketer lost the end of a tone
 * guardrail ("never promise … use only facts in this brief") with no notice
 * (reported 2026-11-15, briefService.ts:208/210). Messaging prose now keeps up to
 * TEXT_MAX (2000) whole, and a longer value is a typed refusal naming the field,
 * never a truncation. Red before the fix: the 400-character values came back cut
 * at 160 and the 2001-character value was saved truncated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBrief, updateBrief, __clearBriefs } from '../src/features/campaign-brief/briefService.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { OpenwopError } from '../src/types.js';

const GUARDRAIL = 'Warm, plain and specific. '.repeat(14) + 'Never promise outcomes; use only facts in this brief.';
const CTA = 'Book a 20-minute portfolio review, then invite them to the designer community. '.repeat(5);

beforeEach(async () => { initHostExtPersistence(await openStorage('memory://')); });
afterEach(async () => { await __clearBriefs(); });

describe('CC-BRIEF-2 — messaging prose is kept whole or refused, never cut', () => {
  it('keeps a long tone override and CTA strategy intact through create and update', async () => {
    expect(GUARDRAIL.length).toBeGreaterThan(160);
    expect(CTA.trim().length).toBeGreaterThan(160);
    const b = await createBrief('t1', 'org-1', 'u1', {
      name: 'Designer outreach',
      messaging: { primaryValueProp: 'Decide faster', toneOverride: GUARDRAIL, proofPoints: [], ctaStrategy: CTA },
    });
    expect(b.messaging.toneOverride).toBe(GUARDRAIL);
    expect(b.messaging.ctaStrategy).toBe(CTA.trim());
    const u = await updateBrief('t1', b.id, { messaging: { ...b.messaging, toneOverride: GUARDRAIL + ' Cite the register.' } });
    expect(u?.messaging.toneOverride.endsWith('Cite the register.')).toBe(true);
  });

  it('refuses an over-limit value with a typed error naming the field', async () => {
    const tooLong = 'x'.repeat(2001);
    const err = await createBrief('t1', 'org-1', 'u1', {
      name: 'Too long', messaging: { primaryValueProp: 'v', toneOverride: tooLong, proofPoints: [], ctaStrategy: '' },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    const e = err as OpenwopError;
    expect(e.code).toBe('validation_error');
    expect((e.details as { field?: string; reason?: string }).field).toBe('messaging.toneOverride');
    expect((e.details as { reason?: string }).reason).toBe('too_long');
  });
});
