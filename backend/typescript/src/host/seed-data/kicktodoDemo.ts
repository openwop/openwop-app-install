/**
 * KickTodo demo content (app-seeding-strategy.md §4 Phase 11, §7 extensibility).
 *
 * Three published challenges plus one enrollment. Deliberately NOT Solstice
 * Roasters: that narrative is a coffee company's commerce/CRM graph, and a
 * guided-achievement challenge about sleep has nothing to buy. §3's rule is that
 * the narrative stays COHERENT, not that every feature sells coffee — so this
 * module keeps the challenge bodies in the domain the PRD describes, authored
 * and enrolled by a dedicated demo subject (`demo:kicktodo`). It imports nothing
 * from `solsticeDemo.ts`: an author drawn from demo-people would couple this
 * seeder to that one's ordering and `clear()`.
 *
 * The three are the ones the product design canvas draws (`design/*.dc.html` in
 * the KickTodo distribution), so a seeded tenant can be compared against the
 * intended screens instead of against an empty state.
 *
 * Every id is a stable slug, never a UUID — that is what makes `count()`,
 * `clear()` and re-seed idempotence possible (§2 "Deterministic ids").
 */
import type { ChallengeActivity, EvidencePolicy } from '../../features/kicktodo-core/types.js';

/** Marker embedded in every seeded challenge id. `clear()` matches ONLY this. */
export const KICKTODO_DEMO_PREFIX = 'chal:demo-kicktodo-';

/** The seeded author/participant subject — kept out of the real user namespace. */
export const KICKTODO_DEMO_ACTOR = 'demo:kicktodo';

export interface DemoChallenge {
  slug: string;
  title: string;
  summary: string;
  outcome: string;
  durationDays: number;
  depthLevel: 'beginner' | 'intermediate' | 'advanced';
  activities: ChallengeActivity[];
}

/** One activity per day, cycling the supplied bodies. Keeps the fixture small
 *  while still producing a real day-by-day curriculum the Plan view can render. */
function daily(
  slug: string,
  durationDays: number,
  bodies: ReadonlyArray<{ title: string; instructions: string; minutes: number; evidence: EvidencePolicy }>,
): ChallengeActivity[] {
  const out: ChallengeActivity[] = [];
  for (let day = 1; day <= durationDays; day += 1) {
    const b = bodies[(day - 1) % bodies.length]!;
    out.push({
      stableActivityId: `${slug}-d${day}`,
      day,
      title: b.title,
      instructions: b.instructions,
      estimatedMinutes: b.minutes,
      evidencePolicy: b.evidence,
    });
  }
  return out;
}

export const KICKTODO_DEMO_CHALLENGES: readonly DemoChallenge[] = [
  {
    slug: 'sleep-reset',
    title: 'Sleep Reset',
    summary: 'Wind down earlier, wake at a steady hour, and find the one lever that moves your sleep most.',
    outcome: 'A consistent wake time and an evening routine you can keep on a bad day.',
    durationDays: 21,
    depthLevel: 'beginner',
    activities: daily('sleep-reset', 21, [
      {
        title: 'Screens down by 10:30pm',
        instructions: 'Put the phone somewhere that is not your bedroom. Note what you did instead.',
        minutes: 5,
        evidence: 'note',
      },
      {
        title: 'Record last night’s sleep',
        instructions: 'Hours slept, to the nearest half hour. A wearable can fill this in for you.',
        minutes: 2,
        evidence: 'measurement',
      },
      {
        title: 'Same wake time, including today',
        instructions: 'Get up at your chosen hour even if the night was poor. Consistency is the lever.',
        minutes: 1,
        evidence: 'attestation',
      },
    ]),
  },
  {
    slug: 'deep-work',
    title: 'Deep Work',
    summary: 'One protected block a day, phone in a drawer, on the thing that actually matters.',
    outcome: 'A daily focus habit that survives a busy calendar.',
    durationDays: 30,
    depthLevel: 'intermediate',
    activities: daily('deep-work', 30, [
      {
        title: 'One 40-minute block, phone in a drawer',
        instructions: 'Pick the task before you start. Shorten the block rather than skip it.',
        minutes: 40,
        evidence: 'note',
      },
      {
        title: 'Name tomorrow’s block',
        instructions: 'Decide the single task and the time. Deciding in advance is most of the work.',
        minutes: 5,
        evidence: 'note',
      },
    ]),
  },
  {
    slug: 'morning-movement',
    title: 'Morning Movement',
    summary: 'Twenty minutes outside before the day starts making demands of you.',
    outcome: 'Movement early enough that the rest of the day cannot crowd it out.',
    durationDays: 14,
    depthLevel: 'beginner',
    activities: daily('morning-movement', 14, [
      {
        title: 'Twenty minutes outside',
        instructions: 'Walk, run, or cycle — pace does not matter. Before your first meeting.',
        minutes: 20,
        evidence: 'attestation',
      },
      {
        title: 'Log how it felt',
        instructions: 'One line. You are building a record you can read back, not a training log.',
        minutes: 2,
        evidence: 'note',
      },
    ]),
  },
] as const;
