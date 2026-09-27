/**
 * ADR 0499 — credential-ref referential integrity.
 *
 * A BYOK secret could be deleted out from under every config that named it. The
 * config kept the dead ref, still validated, still rendered, and failed only at
 * USE time as a 400 far from the edit that caused it — that is how live voice
 * stayed broken for a month behind a `credentialRef:"google:myndhyve-key"` whose
 * secret no longer existed.
 *
 * Three properties are proven here:
 *   1. the registry fans out and FAILS CLOSED (a throwing consumer must never
 *      read as "nothing references this");
 *   2. the honest-scope arms (no tenant / host-scoped) stay `known:false`;
 *   3. the TRIPWIRE — every module that persists a credentialRef registers a
 *      consumer, so the index cannot drift back into a hand-kept list.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  registerCredentialRefConsumer,
  findCredentialRefConsumers,
  lookupCredentialRefConsumers,
  listCredentialRefConsumerIds,
  __resetCredentialRefConsumers,
} from '../src/host/credentialRefRegistry.js';

const SRC = join(__dirname, '../src');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('ADR 0499 — the registry', () => {
  beforeEach(() => { __resetCredentialRefConsumers(); });

  it('aggregates descriptions across consumers', async () => {
    registerCredentialRefConsumer({ id: 'a', describe: async (_t, r) => (r === 'k' ? ['binding A'] : []) });
    registerCredentialRefConsumer({ id: 'b', describe: async (_t, r) => (r === 'k' ? ['binding B'] : []) });

    expect(await findCredentialRefConsumers('t1', 'k')).toEqual(['binding A', 'binding B']);
    expect(await findCredentialRefConsumers('t1', 'other')).toEqual([]);
  });

  it('THROWS when a consumer throws — never reports "nothing references this"', async () => {
    registerCredentialRefConsumer({ id: 'ok', describe: async () => [] });
    registerCredentialRefConsumer({ id: 'broken', describe: async () => { throw new Error('storage down'); } });

    await expect(findCredentialRefConsumers('t1', 'k')).rejects.toThrow(/broken/);
  });

  it('a throwing consumer surfaces as known:false, not as an empty consumer set', async () => {
    registerCredentialRefConsumer({ id: 'broken', describe: async () => { throw new Error('storage down'); } });

    // The routes catch and translate; what must never happen is `known:true, []`.
    await expect(lookupCredentialRefConsumers('t1', 'k')).rejects.toThrow();
  });

  it('re-registration replaces rather than stacking (module singletons)', async () => {
    registerCredentialRefConsumer({ id: 'dup', describe: async () => ['first'] });
    registerCredentialRefConsumer({ id: 'dup', describe: async () => ['second'] });

    expect(await findCredentialRefConsumers('t1', 'k')).toEqual(['second']);
  });

  it('is known:false with no tenant context — the wildcard admin bearer cannot enumerate', async () => {
    registerCredentialRefConsumer({ id: 'a', describe: async () => ['would have matched'] });

    const lookup = await lookupCredentialRefConsumers(undefined, 'k');
    expect(lookup.known).toBe(false);
    if (!lookup.known) expect(lookup.reason).toMatch(/tenant/i);
  });

  it('is known:false for a HOST-scoped ref — it resolves for every tenant', async () => {
    // `billing:stripe-key` is exactly this class: a one-tenant answer would read
    // as "safe to delete" on a secret whose loss degrades every checkout.
    const lookup = await lookupCredentialRefConsumers('t1', 'billing:stripe-key', { hostScoped: true });
    expect(lookup.known).toBe(false);
    if (!lookup.known) expect(lookup.reason).toMatch(/every tenant/i);
  });

  it('is known:true with an empty set only when it genuinely looked', async () => {
    registerCredentialRefConsumer({ id: 'a', describe: async () => [] });

    const lookup = await lookupCredentialRefConsumers('t1', 'k');
    expect(lookup).toEqual({ known: true, consumers: [] });
  });
});

describe('ADR 0499 — tripwire (source scan)', () => {
  const files = walkTs(SRC);

  /**
   * A module "persists a credentialRef" when it declares one as a field on an
   * interface AND owns a DurableCollection. That combination is what creates a
   * ref that outlives its secret; a module that merely PASSES a ref around
   * (dispatch, node config plumbing) holds nothing and needs no consumer.
   */
  const persistsCredentialRef = (src: string): boolean =>
    /^\s*credentialRef\??:\s*string/m.test(src) && /new DurableCollection</.test(src);

  /**
   * The heuristic deliberately OVER-approximates: a file can declare a
   * credentialRef interface and own an unrelated DurableCollection (voiceSession
   * does exactly that — `AgentVoice.credentialRef` rides the agent PROFILE, not
   * its own `VoiceSession` store). Narrowing the scan to the collection's type
   * parameter would fix that but would then MISS the nested holders that matter
   * most (`embeddingSpec.credentialRef`, `configParameters.voice.credentialRef`),
   * which is the wrong direction to be wrong in. So: over-approximate, and let a
   * file opt out with a greppable justification that names its registrar.
   */
  const OPT_OUT = 'ADR 0499: no persisted credentialRef';

  it('every module that persists a credentialRef registers a consumer', () => {
    const unregistered = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      if (!persistsCredentialRef(src)) return false;
      if (src.includes(OPT_OUT)) return false;
      return !src.includes('registerCredentialRefConsumer(');
    });

    expect(unregistered.map((f) => f.slice(SRC.length + 1)).sort()).toEqual([]);
  });

  it('every opt-out names the module that registers on its behalf', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (!src.includes(OPT_OUT)) continue;
      const line = src.split('\n').find((l) => l.includes(OPT_OUT)) ?? '';
      const idx = src.split('\n').indexOf(line);
      const context = src.split('\n').slice(idx, idx + 4).join(' ');
      expect(context, `${f} opts out of ADR 0499 without naming a registrar`)
        .toMatch(/registered (?:by|as)/);
    }
  });

  it('the hand-kept consumer list is gone — the index is the registry', () => {
    const vault = readFileSync(join(SRC, 'routes/adminVault.ts'), 'utf8');
    // The old shape was a local `refConsumers()` that someone had to remember to
    // extend; it had drifted to two entries and never knew about realtime voice.
    expect(vault).not.toMatch(/async function refConsumers\s*\(/);
    expect(vault).toContain('lookupCredentialRefConsumers(');
  });

  it('BOTH delete paths consult the registry — not just the vault', () => {
    // routes/byok.ts is the Keys-page delete, and it is the one that actually
    // orphaned a live binding in production while the vault guard sat unreachable.
    for (const route of ['routes/byok.ts', 'routes/adminVault.ts']) {
      const src = readFileSync(join(SRC, route), 'utf8');
      expect(src, `${route} must consult the consumer registry before deleting`)
        .toContain('lookupCredentialRefConsumers(');
    }
  });
});

describe('ADR 0499 — the real holders register', () => {
  it('covers the bindings that could dangle, including the one that did', async () => {
    // Import for side effects: registration happens at module load, as with
    // registerRetentionPurger.
    await import('../src/host/headlessAi.js');
    await import('../src/host/chatByokConfig.js');
    await import('../src/features/voice/realtime/config.js');
    await import('../src/host/agentProfileService.js');
    await import('../src/host/compatEndpoints.js');
    await import('../src/host/workflowOwnership.js');
    await import('../src/features/kb/kbService.js');
    await import('../src/features/connections/connectionsService.js');
    await import('../src/features/connections/inboundWebhooks.js');
    await import('../src/features/priority-matrix/federationService.js');
    await import('../src/features/email/bounceWebhooks.js');

    const ids = listCredentialRefConsumerIds();
    expect(ids).toContain('voice:realtime-config'); // the production incident
    expect(ids).toContain('host:headlessAiDefault');
    expect(ids).toContain('host:chatByokConfig'); // ADR 0517 — the chat's own binding
    expect(ids).toContain('agent-profile:voice');
    expect(ids).toContain('compat:endpoint');
    expect(ids).toContain('workflow:node-config');
    expect(ids).toContain('kb:collection');
    expect(ids).toContain('connections:token');
    expect(ids).toContain('connections:inbound-signing');
    expect(ids).toContain('priority-matrix:peer');
    expect(ids).toContain('email:webhook-verification');
  });
});
