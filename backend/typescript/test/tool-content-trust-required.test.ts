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
 *
 * Wave 61 (protected ratchet, 8 cases kept): the complete-set and WHY cases
 * scanned only `registerFeatureAgentTool({` windows, so the STATIC builtins
 * (agentToolProvider's BUILTINS map, incl. the factory-minted RAG retrievers and
 * projected compute nodes) and factory-minted feature tools
 * (`registerFeatureAgentTool(readTool(…, 'trusted', …))`) were invisible —
 * flipping the RAG retriever to trusted stayed green (probe ct-static-trusted),
 * and so did a `readTool` factory that ignored its parameter (ct-factory).
 * MEASURED 2026-10-23: 15 trusted tools (13 feature-registered + the static
 * `openwop:kanban.add-todo` and `openwop:schema.lookup`), not the 13 pinned.
 * The static set is read at RUNTIME (BUILTINS is populated on bare import, see
 * case 2); feature registrations are read from source as before.
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

/**
 * Every non-test source file under `src/`, read ONCE per test file, in walk order.
 * The scans below used to re-walk and re-read the tree per lookup (once per
 * registration in `idOfConst`), so two cases took 6.5–7.4 s each and hit the
 * 15 s timeout under gate load (train 189, 2026-10-23).
 */
let sourceCache: ReadonlyArray<readonly [string, string]> | undefined;
const sources = (): ReadonlyArray<readonly [string, string]> =>
  (sourceCache ??= walk(SRC).filter((x) => !x.includes('__tests__')).map((f) => [f, readFileSync(f, 'utf8')] as const));

/** Resolve `EXPORTED_CONST` → its tool-id string literal, wherever it is declared. */
function idOfConst(constName: string): string | undefined {
  for (const [, text] of sources()) {
    // `\b` anchors the NAME: unanchored, `PROPOSE_TOOL_ID` matched inside
    // `TEAM_LEDGER_PROPOSE_TOOL_ID = …` whenever that file was walked first, and the
    // trusted `workflows.propose` was reported as `team-ledger.propose`.
    if (!text.includes(constName)) continue;
    const m = new RegExp(`\\b${constName}\\s*=\\s*'([^']+)'`).exec(text);
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
  const files = sources();
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let constName: string | undefined;
  for (const [, text] of files) {
    const m = new RegExp(`export const ([A-Z0-9_]+)\\s*=\\s*'${esc}'`).exec(text);
    if (m) { constName = m[1]; break; }
  }
  for (const [, text] of files) {
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.includes(`name: '${id}'`) || (constName ? l.includes(`name: ${constName},`) : false));
    if (i < 0) continue;
    for (let j = i; j >= Math.max(0, i - 14); j--) {
      const m = /contentTrust: '(trusted|untrusted)'/.exec(lines[j]!);
      if (m) return m[1];
    }
  }
  return undefined;
}

interface FeatureRegistration { at: string; name: string; trusted: boolean; window: string[] }

/**
 * Every `registerFeatureAgentTool(` call in source — an object literal
 * (`registerFeatureAgentTool({ contentTrust: 'trusted', … })`) or a factory call
 * (`registerFeatureAgentTool(readTool(def, run, 'trusted', 'read'))`, where the
 * trust is a positional string-literal argument on its own line).
 */
let registrationCache: FeatureRegistration[] | undefined;
function featureRegistrations(): FeatureRegistration[] {
  if (registrationCache) return registrationCache;
  const out: FeatureRegistration[] = [];
  for (const [f, text] of sources()) {
    if (!text.includes('registerFeatureAgentTool(')) continue;
    const L = text.split('\n');
    L.forEach((ln, i) => {
      if (!/registerFeatureAgentTool\((?!tool: BuiltinTool)/.test(ln) || /function registerFeatureAgentTool/.test(ln)) return;
      const literal = ln.includes('registerFeatureAgentTool({');
      let end = i + 18;
      if (!literal) {
        end = -1;
        for (let k = i + 1; k < L.length; k++) if (/^\s*\)\);/.test(L[k]!)) { end = k; break; }
        if (end < 0) end = i + 40;
      }
      const w = L.slice(i, end + 1);
      const trusted = literal
        ? w.join('\n').includes("contentTrust: 'trusted'")
        : w.some((x) => /^\s*'trusted',/.test(x));
      const c = /name: ([A-Z0-9_]+)/.exec(w.join(' '))?.[1];
      if (c) out.push({ at: `${f}:${i + 1}`, name: idOfConst(c) ?? c, trusted, window: w });
    });
  }
  return (registrationCache = out);
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
    // cheap a gate — a 16th trusted tool must fail here until someone amends this
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
      'openwop:kanban.add-todo',      // static builtin (agentToolProvider BUILTINS)
      'openwop:schema.lookup',        // static builtin (agentToolProvider BUILTINS)
      'openwop:slides.catalog',
      'openwop:walkthroughs.register-draft',
      'openwop:workflows.compose-and-run',
      'openwop:workflows.propose',
    ];
    // (1) Static builtins, read at runtime — covers the static consts AND the
    // tools their factories mint (RAG retrievers, projected compute nodes).
    const staticTrusted = builtinAgentToolIds().filter((id) => builtinAgentTool(id)?.contentTrust === 'trusted');
    expect(builtinAgentToolIds().length, 'no static builtins — the runtime half is vacuous').toBeGreaterThan(3);
    // (2) Feature registrations, read from source: object literals AND factory calls.
    const actual: string[] = [...staticTrusted];
    for (const { name } of featureRegistrations().filter((r) => r.trusted)) actual.push(name);
    expect(actual.sort(), 'the trusted set changed — every addition is unfenced on the chat path').toEqual(EXPECTED);
  });

  it('every TRUSTED tool states WHY — the 15 are the entire security surface', () => {
    // The compiler forces a VALUE but cannot force a REASON, and an unexplained
    // `trusted` is the same fail-open shape one level up: nothing distinguishes
    // "audited, host-authored" from "nobody looked". An error among the untrusted
    // majority costs tokens; an error here costs security — the asymmetry is why
    // only this direction carries the burden of proof.
    const bare: string[] = [];
    for (const r of featureRegistrations().filter((x) => x.trusted)) {
      if (!r.window.slice(0, 16).some((x) => /\/\/\s*TRUSTED:/.test(x))) bare.push(r.at);
    }
    // Static builtins justify trust with the `// RFC 0137 §F1 — <reason>` comment
    // on the line directly above their `contentTrust: 'trusted'` (accepted for
    // statics only; a feature registration must use `// TRUSTED:`).
    const provider = readFileSync(join(SRC, 'host/agentToolProvider.ts'), 'utf8').split('\n');
    const staticTrusted = builtinAgentToolIds().filter((id) => builtinAgentTool(id)?.contentTrust === 'trusted');
    expect(staticTrusted.length, 'no trusted static — the static half is vacuous').toBeGreaterThan(0);
    for (const id of staticTrusted) {
      const i = provider.findIndex((l) => l.includes(`name: '${id}'`));
      let decl = -1;
      for (let j = i; j >= Math.max(0, i - 12); j--) if (provider[j]!.includes("contentTrust: 'trusted'")) { decl = j; break; }
      const why = decl > 0 ? provider[decl - 1]! : '';
      if (i < 0 || !/\/\/\s*(RFC 0137 §F1 —|TRUSTED:)\s*\S/.test(why)) bare.push(`agentToolProvider.ts ${id}`);
    }
    expect(bare, 'a tool classified trusted with no stated justification').toEqual([]);
  });

  it('a FACTORY threads trust rather than hardcoding it', () => {
    // `commerce/agentTools.ts` mints 7 tools through `readTool`. If the factory
    // fixed its own value, those 7 would share ONE decision and the compiler
    // would stop being a complete ratchet — the falsifier the architect named.
    const src = readFileSync(join(SRC, 'features/commerce/agentTools.ts'), 'utf8');
    expect(src, 'readTool must accept contentTrust as a parameter').toMatch(/contentTrust: BuiltinTool\['contentTrust'\]/);
    // …and must RETURN that parameter: a factory that accepts it but writes a
    // literal in its body (`contentTrust: 'trusted'`) collapses the 7 decisions
    // into one just the same (wave-61 probe ct-factory).
    expect(src, 'readTool must return the contentTrust it was given').toMatch(/return \{\s*contentTrust,\s*effect,/);
  });
});
