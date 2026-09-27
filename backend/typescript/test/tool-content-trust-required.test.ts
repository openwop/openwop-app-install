/**
 * RFC 0137 §F1 — `BuiltinTool.contentTrust` is REQUIRED, and the compiler is the
 * ratchet.
 *
 * It was optional, and 166 of 168 registrations therefore defaulted to
 * `trusted` — a fail-OPEN default on a security boundary. Worse, the highest-risk
 * platform tools were among the defaulted: `ai.research.web` (web results) and
 * `core.openwop.http.fetch` (arbitrary remote body) returned attacker-choosable
 * content to a model with no fence at all.
 *
 * These assert the PROPERTIES a hand-kept allowlist cannot: that the type forces
 * the decision, that a factory cannot collapse N decisions into one, and that
 * the classification did not degenerate into fence-everything.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { builtinAgentTool, builtinAgentToolIds } from '../src/host/agentToolProvider.js';

const SRC = join(process.cwd(), 'src');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((e) => {
    const f = join(d, e);
    return statSync(f).isDirectory() ? walk(f) : f.endsWith('.ts') ? [f] : [];
  });

/** Resolve `EXPORTED_CONST` → its tool-id string literal, wherever it is declared. */
function idOfConst(constName: string): string | undefined {
  for (const f of walk(SRC).filter((x) => !x.includes('__tests__'))) {
    const m = new RegExp(`${constName}\\s*=\\s*'([^']+)'`).exec(readFileSync(f, 'utf8'));
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Resolve a tool id's DECLARED trust from SOURCE — never from the registry. A
 * bare test import registers almost nothing, so a registry lookup silently
 * resolves to `undefined` and every assertion built on it passes vacuously.
 * Tools name themselves by an exported const, so resolve the const first.
 */
function trustOf(id: string): string | undefined {
  const files = walk(SRC).filter((f) => !f.includes('__tests__'));
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let constName: string | undefined;
  for (const f of files) {
    const m = new RegExp(`export const ([A-Z0-9_]+)\\s*=\\s*'${esc}'`).exec(readFileSync(f, 'utf8'));
    if (m) { constName = m[1]; break; }
  }
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    const i = lines.findIndex((l) => l.includes(`name: '${id}'`) || (constName ? l.includes(`name: ${constName},`) : false));
    if (i < 0) continue;
    for (let j = i; j >= Math.max(0, i - 14); j--) {
      const m = /contentTrust: '(trusted|untrusted)'/.exec(lines[j]!);
      if (m) return m[1];
    }
  }
  return undefined;
}

describe('RFC 0137 §F1 — every builtin tool declares its trust', () => {
  it('the type makes it REQUIRED — not optional', () => {
    // The whole ratchet rests on this. If it reverts to `contentTrust?:`, a new
    // tool silently defaults to trusted again and no other test here would fire.
    const src = readFileSync(join(SRC, 'host/agentToolProvider.ts'), 'utf8');
    expect(src, 'contentTrust must not be optional on BuiltinTool').not.toMatch(/contentTrust\?:/);
    expect(src).toMatch(/contentTrust: 'trusted' \| 'untrusted';/);
  });

  it('every registered tool actually carries a value at runtime', () => {
    const ids = builtinAgentToolIds();
    expect(ids.length, 'no tools registered — the walk is vacuous').toBeGreaterThan(3);
    const missing = ids.filter((id) => builtinAgentTool(id)?.contentTrust === undefined);
    expect(missing, 'registered tools with no contentTrust').toEqual([]);
  });

  it('the HIGH-RISK platform tools are untrusted', () => {
    // Named explicitly because these are the canonical prompt-injection vectors
    // and were among the 166 silently defaulting to trusted.
    //
    // Asserted against the SOURCE, not the registry. The first draft read
    // `builtinAgentTool(id)` and skipped when the tool was absent — but these
    // are not registered in a bare test import, so the guard written to PREVENT
    // vacuity WAS the vacuity: downgrading `ai.research.web` to trusted left it
    // green. Sabotage caught it.
    const src = readFileSync(join(SRC, 'host/agentToolProvider.ts'), 'utf8').split('\n');
    for (const id of ['openwop:ai.research.web', 'openwop:core.openwop.http.fetch', 'openwop:knowledge.search']) {
      const i = src.findIndex((l) => l.includes(`name: '${id}'`));
      expect(i, `${id} not found in the provider — the assertion would be vacuous`).toBeGreaterThan(-1);
      // Walk back to the nearest declaration above the tool's name.
      let found: string | undefined;
      for (let j = i; j >= Math.max(0, i - 12); j--) {
        const m = /contentTrust: '(trusted|untrusted)'/.exec(src[j]!);
        if (m) { found = m[1]; break; }
      }
      expect(found, `${id} returns attacker-choosable content and MUST be fenced`).toBe('untrusted');
    }
  });

  // The over-fire guard, as NAMED invariants rather than a count. This was
  // `expect(trustedCount).toBeGreaterThan(10)` — a floor that stayed green while
  // BOTH closed-catalog reads below were wrongly fenced, and that would also have
  // stayed green through all five wrong-`trusted` reads. A threshold cannot
  // police WHICH tools are trusted; only names can.
  //
  // Both directions are pinned deliberately: a one-directional guard is how the
  // fence-everything and the fence-nothing failures each hide from the other.
  it.each([
    'openwop:schema.lookup',
    'openwop:slides.catalog',        // slidesCatalogProjection() — closed block catalog
    'openwop:app-builder.catalog',   // projectComponentCatalog() — closed component catalog
  ])('%s stays TRUSTED — host-authored closed catalog', (id) => {
    const t = trustOf(id);
    expect(t, `${id} not found in source — the assertion would be vacuous`).toBeDefined();
    expect(t, 'fencing a closed catalog tells the model to distrust the vocabulary it must author against').toBe('trusted');
  });

  it.each([
    'openwop:runs.diagnose',                      // the failed node's PREDECESSORS' OUTPUTS, verbatim
    'openwop:feature.workflow-author.nodes.get',  // full WorkflowDefinition — user- AND pack-authored strings
    'openwop:feature.agent-author.nodes.get',     // `roster` = existing personas
    'openwop:discovery.search',                   // storefront catalog — merchant-authored
    'openwop:tutorials.catalog',                  // "this workspace's edited copies"
  ])('%s is UNTRUSTED — it reads back stored, non-host-authored text', (id) => {
    const t = trustOf(id);
    expect(t, `${id} not found in source — the assertion would be vacuous`).toBeDefined();
    expect(t, `${id} shipped as trusted; a regression re-opens the §F1 laundering path`).toBe('untrusted');
  });

  it('the COMPLETE trusted set is pinned — joining it must be an explicit act', () => {
    // Since the blanket fence was removed from `agentDispatch` (architect ruling:
    // one decision point, not two), a `trusted` tool is genuinely UNFENCED on the
    // chat path. The former blanket wrap was the backstop that made a
    // misclassification survivable; this list replaces it. A comment alone is too
    // cheap a gate — a 14th trusted tool must fail here until someone amends this
    // list deliberately.
    const EXPECTED = [
      'openwop:accessibility.alt-text.generate',
      'openwop:accessibility.check',
      'openwop:app-builder.catalog',
      'openwop:feature.agent-author.nodes.draft',
      'openwop:feature.agent-author.nodes.persist',
      'openwop:feature.agent-author.nodes.validate',
      'openwop:feature.workflow-author.nodes.draft',
      'openwop:feature.workflow-author.nodes.persist',
      'openwop:feature.workflow-author.nodes.validate',
      'openwop:slides.catalog',
      'openwop:walkthroughs.register-draft',
      'openwop:workflows.compose-and-run',
      'openwop:workflows.propose',
    ];
    const actual: string[] = [];
    for (const f of walk(SRC).filter((x) => !x.includes('__tests__'))) {
      const L = readFileSync(f, 'utf8').split('\n');
      L.forEach((ln, i) => {
        if (!ln.includes('registerFeatureAgentTool({')) return;
        const w = L.slice(i, i + 18);
        if (!w.join('\n').includes("contentTrust: 'trusted'")) return;
        const c = /name: ([A-Z0-9_]+)/.exec(w.join(' '))?.[1];
        if (c) actual.push(idOfConst(c) ?? c);
      });
    }
    expect(actual.sort(), 'the trusted set changed — every addition is unfenced on the chat path').toEqual(EXPECTED);
  });

  it('every TRUSTED tool states WHY — the 13 are the entire security surface', () => {
    // The compiler forces a VALUE but cannot force a REASON, and an unexplained
    // `trusted` is the same fail-open shape one level up: nothing distinguishes
    // "audited, host-authored" from "nobody looked". An error among the untrusted
    // majority costs tokens; an error here costs security — the asymmetry is why
    // only this direction carries the burden of proof.
    const bare: string[] = [];
    for (const f of walk(SRC).filter((x) => !x.includes('__tests__'))) {
      const L = readFileSync(f, 'utf8').split('\n');
      L.forEach((ln, i) => {
        if (!ln.includes('registerFeatureAgentTool({')) return;
        const w = L.slice(i, i + 16);
        if (!w.join('\n').includes("contentTrust: 'trusted'")) return;
        if (!w.some((x) => /\/\/\s*TRUSTED:/.test(x))) bare.push(`${f}:${i + 1}`);
      });
    }
    expect(bare, 'a tool classified trusted with no stated justification').toEqual([]);
  });

  it('a FACTORY threads trust rather than hardcoding it', () => {
    // `commerce/agentTools.ts` mints 7 tools through `readTool`. If the factory
    // fixed its own value, those 7 would share ONE decision and the compiler
    // would stop being a complete ratchet — the falsifier the architect named.
    const src = readFileSync(join(SRC, 'features/commerce/agentTools.ts'), 'utf8');
    expect(src, 'readTool must accept contentTrust as a parameter').toMatch(/contentTrust: BuiltinTool\['contentTrust'\]/);
  });
});
