/**
 * ADR 0944 D3 / D7 test 7 — no dispatch builds its own memory scope.
 *
 * Before ADR 0944 the run lane (`agentRunnerNode.ts`) and the ad-hoc dispatch
 * lane (`liveDispatchLane.ts`) each passed `agentMemoryScope(profileId)` straight
 * into dispatch, so the profile's `memoryScope` was ignored on both (finding M2).
 * A new `per-org` value added only to the resolver would have been bypassed the
 * same way. This ratchet keeps every lane on `resolveAgentMemory`:
 *
 *  1. `agentMemoryScope(` is called only by the resolver's own module and by the
 *     two callers that address an agent's OWN namespace on purpose and never for
 *     a dispatch: roster teardown and the advisory-board seed.
 *  2. Every `memoryScope:` value handed to dispatch is a resolver result
 *     (`memoryBinding.scope`); profile-mode literals and type annotations are the
 *     only other values allowed. A shorthand `memoryScope,` is refused outside the
 *     profile service, whose `memoryScope` is the profile field.
 *  3. `resolveSubjectKnowledgeRetrieve(` (the knowledge lane's memory read) has a
 *     fixed caller set, each with the subject it reads; a new caller must be
 *     added here deliberately.
 *
 * Sabotage-witnessed (P0): restoring `memoryScope: agentMemoryScope(runnerIdentity.profileId)`
 * in `agentRunnerNode.ts` reds rules 1 and 2; restoring the shorthand
 * `memoryScope,` in `liveDispatchLane.ts` reds rule 2.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Source with line and block comments removed, so a comment that names a call is not a call. */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Split a call's argument list on its TOP-LEVEL commas (a nested call or
 *  object literal keeps its own), so an argument's position is its position. */
function topLevelArgs(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const ALL = files(SRC).map((p) => ({ rel: relative(SRC, p), src: code(p) }));

describe('ADR 0944 D3 — memory scopes come from the ONE resolver', () => {
  it('rule 1: `agentMemoryScope(` has a fixed, non-dispatch caller set', () => {
    const callers = ALL.filter((f) => /\bagentMemoryScope\(/.test(f.src)).map((f) => f.rel).sort();
    expect(callers).toEqual([
      'host/advisoryBoardSeed.ts', // seeds an advisor's own principles (no dispatch)
      'host/agentMemoryAdapter.ts', // the resolver itself
      'host/rosterCascade.ts', // purges a removed agent's own namespace
    ]);
  });

  it('rule 2: every `memoryScope` handed to dispatch is a resolver result', () => {
    const allowedValue = /^(memoryBinding\.scope|string|AgentProfile\['memoryScope'\]|NonNullable<AgentProfile\['memoryScope'\]>|input\.memoryScope|prior\.memoryScope|'agent'|'per-user'|'per-org')$/;
    const offending: string[] = [];
    const dispatchSites: string[] = [];
    for (const f of ALL) {
      if (f.rel === 'types.ts') continue; // the profile field's declaration
      for (const m of f.src.matchAll(/\bmemoryScope\??:\s*([^,;\n})]+)/g)) {
        const value = m[1]!.trim();
        if (!allowedValue.test(value)) offending.push(`${f.rel}: memoryScope: ${value}`);
        if (value === 'memoryBinding.scope') dispatchSites.push(f.rel);
      }
      const shorthand = /^\s*memoryScope,\s*$/m.test(f.src) || /\{\s*(?:\.\.\.\w+,\s*)?memoryScope\s*[,}]/.test(f.src);
      if (f.rel !== 'host/agentProfileService.ts' && shorthand) offending.push(`${f.rel}: shorthand memoryScope`);
    }
    expect(offending).toEqual([]);
    // Non-vacuity: both dispatch lanes are still found by the pattern above.
    expect(dispatchSites.sort()).toEqual(['host/agentRunnerNode.ts', 'host/liveDispatchLane.ts']);
  });

  it('rule 3: the knowledge lane`s memory read has a fixed caller set', () => {
    const calls = ALL.flatMap((f) =>
      [...f.src.matchAll(/\bresolveSubjectKnowledgeRetrieve\(([^;]*?)\)\s*;/g)].map((m) => `${f.rel}: ${topLevelArgs(m[1]!)[3]}`),
    ).sort();
    expect(calls).toEqual([
      // `memoryScope` here is `resolveAgentMemoryScope(profile, actor)` — the agent lane.
      'features/profile-memory/profileKnowledgeService.ts: subjectMemoryScope(userSubject(userId))',
      'features/projects/projectKnowledgeService.ts: subjectMemoryScope(projectSubject(projectId))',
      "features/twin/borrowedRecall.ts: subjectMemoryScope({ kind: 'user', id: link.userId })",
      'host/agentKnowledgeComposition.ts: memoryScope',
      // `composeKnowledgeForSubject` — a conversation OWNER's knowledge (ADR 0045).
      // The chat lane's client binding is ADR 0944 P1.
      'host/agentKnowledgeComposition.ts: subjectMemoryScope(subject)',
    ]);
  });
});
