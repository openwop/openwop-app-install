/**
 * UX_UPGRADE-projects ROUND 2 — PRJ2-M5.
 *
 * `parseCharter` silently `.slice()`s and truncates a charter on a FULL-REPLACE
 * patch and then answers 200 with the trimmed result, so the only place the
 * loss can be prevented is the editor. The editor now mirrors these caps
 * (`frontend/react/src/features/projects/projectsClient.ts` → `CHARTER_LIMITS`)
 * — which makes them a TWO-SIDED constant with no shared module between the
 * packages.
 *
 * This file is the pin. It asserts the truncation BEHAVIOURALLY (not by reading
 * the constants, which would pass against any number), so raising or lowering a
 * cap on the backend goes red here with the frontend value it must be matched
 * to. Failing this test means the editor is now promising a limit the server
 * does not honour — a save that reports success and quietly drops content.
 *
 * Witnessed (w13): each cap's `cleanString(…, N)` bumped and each `.slice(0, MAX_…)`
 * removed in `parseCharter` turns the matching case red.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createProject, updateProject } from '../src/features/projects/projectsService.js';

// Service level: the caps live in `parseCharter`, reached through `updateProject`. Only
// persistence is needed — booting `createApp` cost ~10 s for a claim no route carries.
beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-charter-caps-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

/** MUST equal `CHARTER_LIMITS` in the frontend projects client, field for field. */
const FRONTEND_CHARTER_LIMITS = {
  goal: 200,
  brief: 8000,
  objectives: 20,
  objectiveLength: 200,
  milestones: 50,
  milestoneTitle: 160,
} as const;

const T = 'tenant-charter-caps';

/**
 * Prose of exactly `n` characters. NOT `'x'.repeat(n)`: a long run of one
 * character is SECRET-SHAPED, and the host's redactor rewrites it to
 * `[REDACTED:secret-shaped]` on the way through — which reads as a truncation
 * bug and silently invalidates every length assertion below. Cost the first
 * version of this file all four of its tests.
 */
const prose = (n: number): string => {
  const words = ['ship', 'the', 'charter', 'review', 'with', 'a', 'clear', 'owner', 'and', 'date'];
  let s = '';
  for (let i = 0; s.length < n; i += 1) s += `${words[i % words.length]} `;
  return s.slice(0, n);
};

describe('PRJ2-M5 — the charter caps the editor mirrors are the ones the server enforces', () => {
  const mk = async (): Promise<string> => (await createProject(T, 'org-1', { name: 'Caps' })).id;

  it('accepts exactly the frontend cap and truncates ONE over it', async () => {
    const id = await mk();
    const at = prose(FRONTEND_CHARTER_LIMITS.goal);
    const over = prose(FRONTEND_CHARTER_LIMITS.goal + 1);

    const kept = await updateProject(T, id, { charter: { goal: at } });
    expect(kept.charter?.goal).toBe(at);

    const cut = await updateProject(T, id, { charter: { goal: over } });
    // Documented design (PRJC-DEBT-3), not a defect: no error, no 400 — a 200 carrying less than was sent.
    expect(cut.charter?.goal).toHaveLength(FRONTEND_CHARTER_LIMITS.goal);
  });

  it('drops objectives past the cap, and truncates each one past its own cap', async () => {
    const id = await mk();
    const many = Array.from({ length: FRONTEND_CHARTER_LIMITS.objectives + 3 }, (_, i) => `objective ${i}`);
    const dropped = await updateProject(T, id, { charter: { objectives: many } });
    expect(dropped.charter?.objectives).toHaveLength(FRONTEND_CHARTER_LIMITS.objectives);

    const long = await updateProject(T, id, {
      charter: { objectives: [prose(FRONTEND_CHARTER_LIMITS.objectiveLength + 50)] },
    });
    expect(long.charter?.objectives?.[0]).toHaveLength(FRONTEND_CHARTER_LIMITS.objectiveLength);
  });

  it('drops milestones past the cap, and truncates each title past its own cap', async () => {
    const id = await mk();
    const many = Array.from({ length: FRONTEND_CHARTER_LIMITS.milestones + 5 }, (_, i) => ({ title: `ms ${i}`, done: false }));
    const dropped = await updateProject(T, id, { charter: { milestones: many } });
    expect(dropped.charter?.milestones).toHaveLength(FRONTEND_CHARTER_LIMITS.milestones);

    const long = await updateProject(T, id, {
      charter: { milestones: [{ title: prose(FRONTEND_CHARTER_LIMITS.milestoneTitle + 40), done: false }] },
    });
    expect(long.charter?.milestones?.[0]?.title).toHaveLength(FRONTEND_CHARTER_LIMITS.milestoneTitle);
  });

  it('truncates the brief at the frontend cap', async () => {
    const id = await mk();
    const cut = await updateProject(T, id, { charter: { brief: prose(FRONTEND_CHARTER_LIMITS.brief + 100) } });
    expect(cut.charter?.brief).toHaveLength(FRONTEND_CHARTER_LIMITS.brief);
  });
});
