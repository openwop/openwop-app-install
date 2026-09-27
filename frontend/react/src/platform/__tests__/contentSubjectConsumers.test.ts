import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_KEYS } from '../storage.js';

/**
 * IDN-11 ratchet — every `content`-class storage key has a React consumer that
 * re-reads when the ADR 0434 / IDN-3 boot-window tri-state settles.
 *
 * Why a ratchet and not an abstraction: an unwired consumer is an ABSENCE. You
 * cannot refactor an absence away — there is no seam a forgetful author is
 * forced through, because forgetting means not calling the seam at all. The
 * only thing that catches it is an enumeration that fails when a new
 * `content` key shows up without a subscriber.
 *
 * The failure this guards is silent by construction: the surface renders
 * successfully, against the anonymous scope, and simply shows the wrong
 * (usually empty) content until something unrelated triggers a refresh. No
 * error, no console warning, no failing request.
 *
 * If you add a `content` key: wire its React consumer to `useStorageSubject`,
 * depend on the PRIMITIVE key (never the returned object — a fresh object each
 * render re-runs the effect every render), and add the row here.
 */

const SRC = join(process.cwd(), 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** content key → the React module that must re-read when the subject settles. */
const CONSUMERS: Record<string, string> = {
  chatSessionsIndex: 'chat/hooks/useChatSessions.ts',
  promptsUser: 'prompts/PromptLibraryPage.tsx',
  builderWorkflows: 'builder/WorkflowsDashboard.tsx',
  chatSession: 'chat/hooks/chatSession/core.ts',
};

describe('content-class storage consumers observe the boot-window tri-state (IDN-11)', () => {
  const contentKeys = Object.entries(STORAGE_KEYS)
    .filter(([, spec]) => (spec as { cls?: string }).cls === 'content')
    .map(([name]) => name);

  it('finds the content-class corpus (non-vacuous)', () => {
    expect(contentKeys.length).toBeGreaterThan(0);
  });

  it('every content key is listed here — a new one must be wired, not silently added', () => {
    const unlisted = contentKeys.filter((k) => !(k in CONSUMERS));
    expect(
      unlisted,
      `These \`content\` storage keys have no declared subject-aware consumer:\n  ${unlisted.join('\n  ')}\n` +
        'Wire the surface to useStorageSubject (see chat/hooks/useChatSessions.ts) and add it to CONSUMERS.',
    ).toEqual([]);
  });

  it.each(Object.entries(CONSUMERS))('%s → %s subscribes and depends on the primitive key', (_key, module) => {
    const src = read(module);
    expect(src, `${module} must import useStorageSubject`).toContain('useStorageSubject');
    // The object-vs-primitive distinction is the actual bug risk, so pin it:
    // the module must derive a primitive `subjectKey`, not put the returned
    // object straight into a dependency array.
    expect(src, `${module} must derive a primitive subjectKey`).toMatch(/subjectKey\s*=/);
    // …and must actually USE it as an effect dependency. Asserting only that the
    // declaration exists was theater: deleting `subjectKey` from the dep array
    // is precisely the regression that breaks the re-read, and the declaration
    // survives it untouched. Verified by sabotage — this assertion is the one
    // that catches it.
    expect(
      src,
      `${module} declares subjectKey but never lists it as an effect dependency — ` +
        'the re-read on settle will not fire.',
    ).toMatch(/\[[^\]]*\bsubjectKey\b[^\]]*\]/);
  });
});
