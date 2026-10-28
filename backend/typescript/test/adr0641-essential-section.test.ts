/**
 * ADR 0641 decision 8 + test-plan item 3 — an essential section REFUSES rather
 * than degrading to empty chrome.
 *
 * The decision names the severity precisely, and it is the reason this test
 * exists at all: when a resolver returns `{items: []}` **every check we have
 * passes**. The route 200s, the prerender emits a well-formed document, the
 * section chrome is intact, the hosting gate is satisfied, deploy verification
 * is satisfied — and the indexed page lists zero challenges. The only signal is
 * a business metric nobody is watching yet.
 *
 * So the assertions below are about the EMPTY case as much as the error case.
 * A guard that only caught throwing resolvers would miss the shape that
 * actually ships.
 *
 * Tracker TST-BG3-15. Red when: an essential resolver that throws, returns `{items: []}`
 * or returns null is passed through (or the refusal reports the wrong reason), a
 * NON-essential resolver's throw propagates, `essential: true` is no longer recorded
 * at registration, or the refusal message loses its "hollow page" explanation.
 *
 * Not tested, and not testable: `resolveContentSection`'s "essential type with NO
 * resolver" branch is unreachable through the public API (essentialness is only ever
 * recorded right after the resolver is), so its sabotage stays green. Recorded as
 * product row TST-BG3-15a.
 */

import { describe, it, expect } from 'vitest';
import {
  type ResolvedContentSection,
  registerContentSectionResolver,
  resolveContentSection,
  isEssentialSectionType,
  EssentialSectionUnresolved,
} from '../src/host/contentDataSources.js';

// Unique per registration — the registry is process-wide and refuses duplicates.
let n = 0;
const freshType = (): string => `t${Date.now()}_${n++}`;

/** Run the resolution and hand back the refusal it MUST produce, typed. */
async function refusalOf(t: string): Promise<EssentialSectionUnresolved> {
  const outcome: unknown = await resolveContentSection(t, {}, {}).then(
    (value: ResolvedContentSection | null) => ({ resolved: value }),
    (e: unknown) => e,
  );
  expect(outcome).toBeInstanceOf(EssentialSectionUnresolved);
  if (!(outcome instanceof EssentialSectionUnresolved)) throw new Error('unreachable: asserted above');
  return outcome;
}

describe('ADR 0641 d8 — default sections still degrade (unchanged contract)', () => {
  it('a NON-essential resolver that throws degrades to null', async () => {
    const t = freshType();
    registerContentSectionResolver(t, async () => { throw new Error('boom'); });
    await expect(resolveContentSection(t, {}, {})).resolves.toBeNull();
  });

  it('a NON-essential resolver that returns empty is accepted as-is', async () => {
    const t = freshType();
    registerContentSectionResolver(t, async () => ({ items: [] }));
    await expect(resolveContentSection(t, {}, {})).resolves.toEqual({ items: [] });
  });

  it('an unregistered type is still null, not an error', async () => {
    await expect(resolveContentSection(freshType(), {}, {})).resolves.toBeNull();
  });
});

describe('ADR 0641 d8 — an ESSENTIAL section refuses', () => {
  it('REFUSES on empty — the case that would otherwise ship a hollow page', async () => {
    const t = freshType();
    registerContentSectionResolver(t, async () => ({ items: [] }), { essential: true });
    await expect(resolveContentSection(t, {}, {})).rejects.toBeInstanceOf(EssentialSectionUnresolved);
    await expect(resolveContentSection(t, {}, {})).rejects.toMatchObject({ reason: 'empty' });
  });

  it('REFUSES when the resolver throws, and keeps the cause', async () => {
    const t = freshType();
    const cause = new Error('store down');
    registerContentSectionResolver(t, async () => { throw cause; }, { essential: true });
    const err = await refusalOf(t);
    expect(err.reason).toBe('threw');
    expect(err.cause).toBe(cause);
  });

  it('REFUSES when the resolver declines (null)', async () => {
    const t = freshType();
    registerContentSectionResolver(t, async () => null, { essential: true });
    await expect(resolveContentSection(t, {}, {})).rejects.toMatchObject({ reason: 'declined' });
  });

  it('essentialness is recorded at registration, never inferred', async () => {
    // The "essential type with NO resolver" refusal is unreachable through the public
    // API (see the header, TST-BG3-15a); what CAN be pinned is that the flag is the
    // registration's, so an unregistered type is never treated as essential.
    const t = freshType();
    registerContentSectionResolver(t, async () => ({ items: [{ title: 'x' }] }), { essential: true });
    expect(isEssentialSectionType(t)).toBe(true);
    // A different, unregistered-but-essential type cannot be constructed without
    // registering, so assert the branch via the declining resolver above plus
    // this positive: essentialness is recorded at registration, not inferred.
    expect(isEssentialSectionType(freshType())).toBe(false);
  });

  it('PASSES THROUGH a non-empty result unchanged', async () => {
    const t = freshType();
    registerContentSectionResolver(t, async () => ({ items: [{ title: 'Sleep', body: 'Sleep better' }] }), { essential: true });
    await expect(resolveContentSection(t, {}, {})).resolves.toEqual({ items: [{ title: 'Sleep', body: 'Sleep better' }] });
  });

  it('the error message says why a hollow page is worse than a missing one', async () => {
    const t = freshType();
    registerContentSectionResolver(t, async () => ({ items: [] }), { essential: true });
    const err = await refusalOf(t);
    // Message-pinned: a guard that starts firing for a different reason should
    // report that, not pass silently under a familiar class name.
    expect(err.message).toMatch(/resolved to zero items/);
    expect(err.message).toMatch(/passes every other check we have/);
  });
});
