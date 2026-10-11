/**
 * SR-1 (`agent-memory.md` §SR-1) — the memory-write redaction chokepoint, and
 * the long-term-memory advert that depends on it (H49).
 *
 * Before H49 this host had NO memory-write redaction at all: `writeMemoryEntry`
 * persisted whatever it was given, and the executor's run-summary write embeds
 * a slice of the run's OUTPUT — so a run whose output carried a BYOK-resolved
 * value persisted that value verbatim into a memory entry that
 * `GET /host/openwop-app/memory` then served back. That is the exact
 * condition SR-1 exists to forbid, and it was reachable with no fixture
 * involved.
 *
 * The three substitution rules are the spec's own reference-impl notes, and each
 * is asserted here because each has a distinct failure mode:
 *   - substring, not regex   → a secret with metacharacters must still redact
 *   - descending length      → a long secret containing a short one redacts whole
 *   - 8-character floor      → a short secret must NOT shred unrelated content
 *
 * Sabotage-witnessed (w12 grade-tests): a marker without the secretId, a RegExp
 * replacement, ascending sort, a floor of 1 or `>`, a replace-not-merge
 * `registerRunSecret`, each dropped empty-input guard, a chokepoint that skips
 * redaction or persists the raw input, an unconditional / never advert, an advert
 * blind to the global fallback, a bare call in `bootstrap/nodes.ts`, and a
 * placeholder run id at that call each turn a named case red.
 */

import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { resolveBackendId, MEMORY_BACKEND } from '../src/host/surfaceBackends.js';
import {
  redactRunSecretsForMemory,
  SR1_MIN_SECRET_LENGTH,
} from '../src/byok/textRedaction.js';
import {
  setRunSecrets,
  registerRunSecret,
  getRunSecrets,
  clearRunSecrets,
} from '../src/byok/ephemeralRunSecrets.js';
import {
  writeMemoryEntry,
  writeMemoryEntryRedacted,
  getMemoryEntry,
  clearMemoryScope,
  initInMemorySurfaces,
} from '../src/host/inMemorySurfaces.js';

const TENANT = 'h49-sr1';
const REF = 'conformance/h49-sr1';

beforeAll(() => {
  initInMemorySurfaces({ dataDir: '.' });
});

afterEach(() => {
  clearRunSecrets('run-sr1');
  clearRunSecrets('');
});

describe('SR-1 substitution rules (agent-memory.md §SR-1 reference-impl notes)', () => {
  it('replaces the plaintext with the canonical [REDACTED:<secretId>] marker', () => {
    const out = redactRunSecretsForMemory('key is sk-abcdefghijklmnop here', { 'openai': 'sk-abcdefghijklmnop' });
    expect(out).toBe('key is [REDACTED:openai] here');
    expect(out).not.toContain('sk-abcdefghijklmnop');
  });

  it('is SUBSTRING replacement, not regex — a secret full of metacharacters still redacts', () => {
    // Under a regex implementation this either throws, matches nothing, or
    // matches far too much. Under split/join it is inert text.
    const secret = 'a.*+?(){}[]|^$b';
    const out = redactRunSecretsForMemory(`before ${secret} after`, { 'weird': secret });
    expect(out).toBe('before [REDACTED:weird] after');
    // ...and the pattern does NOT match a string it would match as a regex.
    expect(redactRunSecretsForMemory('aXXXb', { 'weird': secret })).toBe('aXXXb');
  });

  it('sorts by DESCENDING length so a long secret containing a short one redacts WHOLE', () => {
    const short = 'shortsecret';
    const long = `${short}-with-a-longer-tail`;
    const out = redactRunSecretsForMemory(`value ${long} end`, { 'short': short, 'long': long });
    // The long one must win. Ascending order would leave "[REDACTED:short]-with-a-longer-tail".
    expect(out).toBe('value [REDACTED:long] end');
    expect(out).not.toContain('with-a-longer-tail');
  });

  it(`applies the ${SR1_MIN_SECRET_LENGTH}-char floor — a short value must not shred unrelated content`, () => {
    const short = 'abc'; // below the floor
    expect(short.length).toBeLessThan(SR1_MIN_SECRET_LENGTH);
    const content = 'abcdefg and abc and abstract';
    expect(redactRunSecretsForMemory(content, { 'tiny': short }), 'a 3-char secret MUST NOT redact').toBe(content);
    // ...while a value AT the floor does redact.
    const atFloor = 'abcdefgh';
    expect(atFloor.length).toBe(SR1_MIN_SECRET_LENGTH);
    expect(redactRunSecretsForMemory('x abcdefgh y', { 'ok': atFloor })).toBe('x [REDACTED:ok] y');
  });

  // CUT (w12 grade-tests), each with the probe that proved the cover:
  //  - `is idempotent` — w12g5-sr1-idempotent-redundant (a marker embedding the value)
  //    turned the marker case above red too; for split/join, idempotence follows from
  //    "the output no longer contains the plaintext", which that case asserts.
  //  - `an empty keyring is a no-op` — w12g5-sr1-emptykeyring-redundant reddened
  //    `an unknown runId degrades to a plain write` below, which drives the same empty
  //    keyring through the real chokepoint.
});

describe('registerRunSecret — MERGES, never replaces', () => {
  it('adds to the executor-seeded keyring instead of wiping it', () => {
    // The failure this guards: reusing `setRunSecrets` here would drop every
    // credentialRef the executor had already resolved for the run.
    setRunSecrets('run-sr1', { declared: 'declared-plaintext-value' });
    registerRunSecret('run-sr1', 'midrun', 'midrun-plaintext-value');
    expect(getRunSecrets('run-sr1')).toEqual({
      declared: 'declared-plaintext-value',
      midrun: 'midrun-plaintext-value',
    });
  });

  it('seeds a keyring for a run that had none', () => {
    registerRunSecret('run-sr1', 'only', 'only-plaintext-value');
    expect(getRunSecrets('run-sr1')).toEqual({ only: 'only-plaintext-value' });
  });

  it('refuses empty inputs so a failed resolution cannot register a match-everything sentinel', () => {
    registerRunSecret('run-sr1', 'blank', '');
    registerRunSecret('run-sr1', '', 'value-with-no-ref');
    registerRunSecret('', 'ref', 'value-with-no-run');
    expect(getRunSecrets('run-sr1')).toEqual({});
    // The empty-runId call registers under run '' — reading 'run-sr1' alone could
    // never see it (w12g5-sr1-empty-runid was vacuous before this line).
    expect(getRunSecrets('')).toEqual({});
  });
});

describe('writeMemoryEntryRedacted — the chokepoint, end to end', () => {
  it('persists the marker and never the plaintext, and the READ side surfaces the redacted form', async () => {
    await clearMemoryScope(TENANT, REF);
    setRunSecrets('run-sr1', { 'anthropic': 'sk-ant-live-plaintext-value-0001' });
    const row = await writeMemoryEntryRedacted(
      TENANT,
      REF,
      { content: 'the run resolved sk-ant-live-plaintext-value-0001 and summarised it', tags: [] },
      'run-sr1',
    );
    // Persisted form.
    expect(row.content).not.toContain('sk-ant-live-plaintext-value-0001');
    expect(row.content).toContain('[REDACTED:anthropic]');
    // Read-back form — the point of SR-1 is the READ surface.
    const back = await getMemoryEntry(TENANT, REF, row.id);
    expect(back?.content).toBe(row.content);
  });

  it('CONTROL: the bare writeMemoryEntry does NOT redact — so the chokepoint is what protects, not the store', async () => {
    // Without this control the assertion above could pass because the store
    // scrubs everything, which would make the chokepoint dead code.
    await clearMemoryScope(TENANT, REF);
    setRunSecrets('run-sr1', { 'anthropic': 'sk-ant-live-plaintext-value-0001' });
    const row = await writeMemoryEntry(TENANT, REF, {
      content: 'raw sk-ant-live-plaintext-value-0001',
      tags: [],
    });
    expect(row.content).toContain('sk-ant-live-plaintext-value-0001');
  });

  it('an unknown runId degrades to a plain write rather than failing the run', async () => {
    await clearMemoryScope(TENANT, REF);
    const row = await writeMemoryEntryRedacted(TENANT, REF, { content: 'no secrets here', tags: [] }, 'no-such-run');
    expect(row.content).toBe('no secrets here');
  });
});

/**
 * `capabilities.agents.memoryBackends: ['long-term']` — DERIVED from the
 * selected memory surface, never asserted (H49).
 *
 * The §A dimension is "cross-run DURABLE store". This host's default `memory`
 * tier is process-local — its own surface advert says "restarts wipe state" —
 * so claiming long-term there would be an over-claim. The conformance lane
 * selects `OPENWOP_SURFACE_MEMORY=durable` (`conformance/run.ts`), which is what
 * EARNS the claim for the run that is measured against it.
 *
 * This is the assertion that keeps the advert honest in both directions: an
 * unconditional claim would pass a "present" test, and a permanently-absent one
 * would pass an "absent" test. Only flipping the surface distinguishes them.
 */
describe('agents.memoryBackends advert is derived from the memory surface', () => {
  function memoryBackends(): unknown {
    const cfg = { port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0', enableConsoleTracer: false };
    // ADR 0812 P4: the v2 `agents` record (the v1 builder is deleted); both
    // majors spread the SAME `longTermMemoryDurable()` derivation.
    const ad = buildV2Advertisement(cfg);
    return (ad as { agents?: { memoryBackends?: unknown } }).agents?.memoryBackends;
  }

  /**
   * `resolveBackendId('memory')` consults TWO env vars — the per-surface
   * `OPENWOP_SURFACE_MEMORY` and the global `OPENWOP_SURFACE_BACKEND` fallback —
   * so a test that controls only the first still depends on ambient state.
   *
   * That is not hypothetical: this file once failed on exactly the "ABSENT"
   * case in a five-file run and then passed four consecutive re-runs of the
   * identical command (load average was ~13 at the time, i.e. peers' suites were
   * running). The cause was never reproduced and is NOT claimed here. What IS
   * claimed: two other files in this suite mutate `OPENWOP_SURFACE_*`
   * (`surface-backends.test.ts`, which restores; `seam-smoke.test.ts`, which
   * sets KV/FS/TABLE in `beforeAll`), vitest reuses a worker across files, and a
   * test asserting a DERIVATION FROM ENV must therefore own every input to that
   * derivation. Both vars are now saved, cleared, and restored, which removes
   * the fragility whatever the original trigger was.
   */
  /**
   * SET, never DELETE.
   *
   * `resolveBackendId('memory')` reads the per-surface `OPENWOP_SURFACE_MEMORY`
   * and returns EARLY when it is set, only falling through to the global
   * `OPENWOP_SURFACE_BACKEND` when it is not. So pinning the per-surface var to
   * an explicit value makes the result depend on exactly ONE piece of state that
   * this test owns — whereas the "absent" case originally *deleted* both vars,
   * which depends on nothing else in the process re-setting either one.
   *
   * That distinction was not academic. This test failed twice under load
   * (~2 in 20 runs) on the "absent" case and then passed 10 consecutive
   * reproduction attempts; the cause was never reproduced and is NOT claimed
   * here. What is claimed: a deleted var is a strictly weaker precondition than
   * a set one, `MEMORY_BACKEND` ('memory') is a legitimate explicit value
   * meaning "the in-memory default", and pinning it removes the whole class
   * without needing the diagnosis. A ~10% flake in the merge gate is worth
   * designing out rather than explaining.
   */
  async function withMemoryBackend<T>(backendId: string, fn: () => Promise<T>): Promise<T> {
    const prevMemory = process.env.OPENWOP_SURFACE_MEMORY;
    process.env.OPENWOP_SURFACE_MEMORY = backendId;
    try {
      return await fn();
    } finally {
      if (prevMemory === undefined) delete process.env.OPENWOP_SURFACE_MEMORY;
      else process.env.OPENWOP_SURFACE_MEMORY = prevMemory;
    }
  }

  it('is ABSENT on the non-durable default tier — no over-claim on a demo deploy', async () => {
    await withMemoryBackend(MEMORY_BACKEND, async () => {
      // Precondition, asserted rather than assumed: if this ever fails the
      // message names the resolution, not the advert.
      expect(
        resolveBackendId('memory'),
        'precondition: the memory surface must resolve to the in-memory default here',
      ).toBe(MEMORY_BACKEND);
      expect(memoryBackends(), 'a process-local tier is not a cross-run durable store').toBeUndefined();
    });
  });

  it("is ['long-term'] when a durable memory backend is selected", async () => {
    await withMemoryBackend('durable', async () => {
      expect(memoryBackends()).toEqual(['long-term']);
    });
  });

  it('the GLOBAL OPENWOP_SURFACE_BACKEND fallback also earns the claim', async () => {
    // `resolveBackendId` honours the global fallback, so the advert must too —
    // otherwise an operator who set the backend globally would get a durable
    // memory tier with no advert to match it. This is the ONE case that must
    // clear the per-surface var, because the fallback is only reachable then.
    const prevMemory = process.env.OPENWOP_SURFACE_MEMORY;
    const prevGlobal = process.env.OPENWOP_SURFACE_BACKEND;
    delete process.env.OPENWOP_SURFACE_MEMORY;
    process.env.OPENWOP_SURFACE_BACKEND = 'durable';
    try {
      expect(memoryBackends()).toEqual(['long-term']);
    } finally {
      if (prevMemory === undefined) delete process.env.OPENWOP_SURFACE_MEMORY;
      else process.env.OPENWOP_SURFACE_MEMORY = prevMemory;
      if (prevGlobal === undefined) delete process.env.OPENWOP_SURFACE_BACKEND;
      else process.env.OPENWOP_SURFACE_BACKEND = prevGlobal;
    }
  });

  // H49's `memory.supported stays FALSE — a deliberate, recorded UNDER-claim`
  // case was DELETED here by H51, on its own instruction ("DELETE this test when
  // §C lands"). §C landed: `host/memoryDimensions.ts` + the `GET /v1/agents`
  // projection, so the under-claim's reason is gone and the flag is `true`. Its
  // replacement is `test/memory-dimensions.test.ts` (the §A model) +
  // `test/memory-degraded-projection-route.test.ts` (the §C wire shape) — both
  // assert what the host DOES, not what it declines to claim.
});

/**
 * NO-GROWTH ratchet — every IN-RUN memory write goes through the SR-1
 * chokepoint (H49).
 *
 * The tests above prove `writeMemoryEntryRedacted` redacts. They cannot prove
 * the CALL SITES use it — and a call site quietly reverted to the bare
 * `writeMemoryEntry` would leave every assertion above green while the actual
 * production write path leaked again. So this derives the call-site set from the
 * SOURCE and pins it: a new bare call is a failure that names the file and makes
 * the author justify it here.
 *
 * The allowlist is small and each entry has a reason. It is deliberately an
 * exact-equality check rather than a subset check — a bare call that DISAPPEARS
 * is also worth noticing, because it usually means someone deleted the write
 * rather than routing it.
 */
describe('SR-1 call-site ratchet — no bare writeMemoryEntry in a run context', () => {
  /** Files permitted to call the BARE `writeMemoryEntry`, with the reason. */
  const ALLOWED: Record<string, string> = {
    'host/inMemorySurfaces.ts':
      'defines it, and `writeMemoryEntryRedacted` delegates to it after redacting',
    'host/subjectMemory.ts':
      'curated notes + the subject port; no runId is in scope at this call boundary, so there is no per-run keyring to redact against. Named residue in ADR 0041 §H49.',
    'bootstrap/conformanceMemoryProbe.ts':
      'the CTI-1 foreign-tenant seed only. That row belongs to a synthetic tenant and carries no secret; redacting it against THIS run keyring would be meaningless.',
  };

  it('every bare writeMemoryEntry( call site is accounted for', () => {
    const SRC = join(import.meta.dirname, '..', 'src');

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(SRC);
    // Non-vacuity: an empty or tiny walk would pass every assertion below.
    expect(files.length, 'the source walk MUST find files').toBeGreaterThan(200);

    const callers = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // Strip line comments so a mention in prose is not read as a call — the
      // exact confusion that produced three false reds in H48.
      const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
      // A BARE call: `writeMemoryEntry(` not preceded by `Redacted`.
      if (/(?<!Redacted)\bwriteMemoryEntry\s*\(/.test(code)) {
        callers.add(relative(SRC, f).split('\\').join('/'));
      }
    }

    // Non-vacuity: the regex must actually find the definition site at minimum.
    expect(callers.has('host/inMemorySurfaces.ts'), 'the regex must match the definition site').toBe(true);
    expect([...callers].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('the two run-context sites DO use the redacting form', () => {
    const SRC = join(import.meta.dirname, '..', 'src');
    // The run id is matched as the chokepoint call's LAST argument. A bare
    // `toContain('run.runId')` could not fail: that string occurs 137× in the
    // executor and `ctx.runId` 44× in nodes.ts (w12g5-sr1-runid-arg was vacuous).
    // `[^;]*` bounds the match to ONE call: a lazy `[\s\S]*?` ran past a sabotaged
    // call to a later `, run.runId);` and stayed green.
    for (const [file, runIdArg] of [
      ['executor/executor.ts', /writeMemoryEntryRedacted\([^;]*,\s*run\.runId,?\s*\);/],
      ['bootstrap/nodes.ts', /writeMemoryEntryRedacted\([^;]*,\s*ctx\.runId\s*\);/],
    ] as const) {
      const code = readFileSync(join(SRC, file), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
      expect(code, `${file} MUST call the redacting form`).toContain('writeMemoryEntryRedacted(');
      expect(code, `${file} MUST pass the run's id as the chokepoint's runId`).toMatch(runIdArg);
    }
  });
});
