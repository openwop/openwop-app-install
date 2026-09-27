/**
 * UX_UPGRADE-projects ROUND 2 — PRJ2-M5, the OTHER half of the pin.
 *
 * `CHARTER_LIMITS` in the projects client mirrors caps that the BACKEND owns
 * (`parseCharter` in `backend/typescript/src/features/projects/projectsService.ts`
 * silently `.slice()`s and truncates, then answers 200). The editor now refuses
 * a save the server would trim — which is only honest while the two sides agree.
 *
 * The backend test (`test/projects-charter-caps.test.ts`) pins the caps
 * behaviourally, so it goes red when a BACKEND number moves. But it re-declares
 * the numbers as a literal — a backend package cannot import frontend code — so
 * it is completely blind in the other direction: set `CHARTER_LIMITS.objectives`
 * to 10 and the whole suite stays green while the editor blocks saves the server
 * would have accepted. Both docstrings claimed "fails if either side moves".
 * Only one direction was true.
 *
 * This file closes it from the frontend side, where reading the backend source
 * IS possible. It parses the constants out of the service rather than asserting
 * literals, so it tracks the real value instead of a copy of it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHARTER_LIMITS } from '../projectsClient.js';

const SERVICE = join(process.cwd(), '../../backend/typescript/src/features/projects/projectsService.ts');
const SRC = readFileSync(SERVICE, 'utf8');

/** `const MAX_OBJECTIVES = 20;` → 20. Throws rather than returning a default:
 *  a silent miss would make every assertion below vacuous. */
function constant(name: string): number {
  const m = new RegExp(`const ${name}\\s*=\\s*(\\d+)`).exec(SRC);
  if (!m) throw new Error(`${name} not found in projectsService.ts — the parser needs updating, not the expectation`);
  return Number(m[1]);
}

/** `cleanString(raw.goal, 200)` → 200. Same failure posture. */
function cleanStringCap(field: string): number {
  const m = new RegExp(`cleanString\\((?:raw|mm)\\.${field},\\s*(\\d+)\\)`).exec(SRC);
  if (!m) throw new Error(`cleanString cap for \`${field}\` not found in projectsService.ts`);
  return Number(m[1]);
}

describe('PRJ2-M5 — the editor promises exactly the caps the server enforces', () => {
  it('reads the backend source at all (the parser is not silently matching nothing)', () => {
    expect(SRC).toContain('function parseCharter');
  });

  it('objective count + per-objective length', () => {
    expect(CHARTER_LIMITS.objectives).toBe(constant('MAX_OBJECTIVES'));
    // The per-objective cap is the `cleanString(o, N)` inside the objectives map.
    // UX_UPGRADE-projects R3 (#3240) wrapped the map callback to refuse
    // secret-shaped objectives before capping, so the callback is now
    // `(o, i) => { refuseSecretShaped(...); return cleanString(o, N); }`.
    // Match the cleanString INSIDE the objectives map without pinning the
    // whole callback shape again (that pin is what broke here).
    const m = /raw\.objectives\.slice\(0, MAX_OBJECTIVES\)\.map\([\s\S]{0,200}?cleanString\(o, (\d+)\)/.exec(SRC);
    expect(m, 'the objectives map shape changed — re-derive the cap').toBeTruthy();
    expect(CHARTER_LIMITS.objectiveLength).toBe(Number(m![1]));
  });

  it('milestone count + title length', () => {
    expect(CHARTER_LIMITS.milestones).toBe(constant('MAX_MILESTONES'));
    expect(CHARTER_LIMITS.milestoneTitle).toBe(cleanStringCap('title'));
  });

  it('goal + brief length', () => {
    expect(CHARTER_LIMITS.goal).toBe(cleanStringCap('goal'));
    expect(CHARTER_LIMITS.brief).toBe(cleanStringCap('brief'));
  });
});
