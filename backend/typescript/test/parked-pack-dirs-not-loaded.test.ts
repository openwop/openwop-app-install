/**
 * Parked pack dirs (`<name>.registry-<version>`) must NEVER be loaded.
 *
 * `mountLocalPacks`'s shadow pass renames a superseded registry install to
 * `<name>.registry-<version>` so it stays recoverable — but the parked dir's
 * pack.json still declares the ORIGINAL pack name. Every pack-dir scanner
 * iterated it anyway, and because the parked name sorts AFTER the live dir,
 * its stale manifest loaded second and overwrote the fresh registration.
 * Found live: `core.openwop.agents.deep-research.registry-1.0.2`
 * (memoryShape.longTerm: false) shadowed the fixed 1.0.4 manifest on
 * `/v1/packs`, keeping the agentPackCatalog conformance leg red after the
 * pack itself was fixed.
 *
 * The per-worker `OPENWOP_PACK_DIR` (setup/isolatePackDir.ts) makes writing
 * into the pack dir safe here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isParkedPackDirName } from '../src/bootstrap/mountLocalPacks.js';
import { loadAllLocalAgents } from '../src/bootstrap/agentPackResolver.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { resolveDefaultPackDir } from '../src/packs/registryInstaller.js';
import { attestPackDir } from './setup/attestPackFixture.js';

const PACK_NAME = 'vendor.test.parked-shadow-probe';
const AGENT_ID = 'vendor.test.parked-shadow-probe.agent';

function manifest(version: string, longTerm: boolean): string {
  return JSON.stringify({
    name: PACK_NAME,
    version,
    kind: 'agents',
    agents: [
      {
        agentId: AGENT_ID,
        persona: 'Parked-shadow probe',
        label: 'Parked-shadow probe',
        description: 'regression probe: live dir must win over a parked sibling',
        modelClass: 'reasoning',
        systemPrompt: 'You are a regression probe. Answer nothing.',
        memoryShape: { scratchpad: true, conversation: false, longTerm },
      },
    ],
  });
}

describe('parked pack dirs are recoverable, never loadable', () => {
  it('isParkedPackDirName matches exactly the shadow-pass rename shape', () => {
    expect(isParkedPackDirName('core.openwop.agents.deep-research.registry-1.0.2')).toBe(true);
    expect(isParkedPackDirName('some.pack.registry-2')).toBe(true);
    expect(isParkedPackDirName('core.openwop.agents.deep-research')).toBe(false);
    // A pack legitimately NAMED "...registry" (no version suffix) is not parked.
    expect(isParkedPackDirName('vendor.acme.registry')).toBe(false);
  });

  describe('a live pack dir wins over its parked sibling', () => {
    beforeAll(() => {
      const packDir = resolveDefaultPackDir();
      const live = join(packDir, PACK_NAME);
      // The parked name sorts AFTER the live dir — the order that made the
      // stale manifest overwrite the fresh one before the scanners filtered.
      const parked = join(packDir, `${PACK_NAME}.registry-0.9.0`);
      mkdirSync(live, { recursive: true });
      mkdirSync(parked, { recursive: true });
      writeFileSync(join(live, 'pack.json'), manifest('1.0.0', true));
      writeFileSync(join(parked, 'pack.json'), manifest('0.9.0', false));
      // ADR 0555 P0 — the agent loader refuses unattested packs. Attest BOTH:
      // the parked dir must stay unloadable because it is PARKED, not because
      // it happens to be untrusted, or this test would pass for the wrong
      // reason and stop guarding the shadow-pass filter it exists to guard.
      attestPackDir(live);
      attestPackDir(parked);
      loadAllLocalAgents();
    });

    it('the registry serves the LIVE manifest, not the parked one', async () => {
      const agent = await getAgentRegistry().resolve(AGENT_ID);
      expect(agent, 'probe agent must load from the live dir').toBeTruthy();
      expect(agent?.memoryShape?.longTerm, 'parked (longTerm:false) manifest must not shadow the live one').toBe(true);
      expect(agent?.packVersion).toBe('1.0.0');
    });
  });
});
