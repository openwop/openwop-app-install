/**
 * ADR 0820 G14 — the access ratchet beyond `resolveToggle`: executor ctx capabilities.
 *
 * `feature-toggle-access-ratchet.test.ts` pins every `resolveToggle` caller, but
 * it cannot see a lane that calls NEITHER resolver, and that is where the paywall
 * gaps actually were: a host capability the executor puts on `ctx` without any
 * feature check (`ctx.ads`, `ctx.callVideoGenerator`, `ctx.canvas`), and a
 * `ctx.features.<id>` surface whose id is not a toggle id, which
 * `featureSurfaces.gate` reads as always-on (`commissions`). This file closes
 * both classes by construction:
 *
 *  1. Every key of the executor's node `ctx` literal (including keys inside
 *     conditional spreads) is declared in `EXECUTOR_CTX_POLICY` as run context,
 *     a gated capability or a justified core capability. The key SET must match
 *     exactly, so a new capability is a red test until someone decides.
 *  2. A `gated` key's value is routed through its declared wrapper in the
 *     executor source, and every concrete feature it names is a real toggle.
 *
 * The surface half (every surface id is a toggle id or declared always-on) is
 * `feature-surface-toggle-ratchet.test.ts`.
 *
 * (2) was observed RED against unmodified source: `ads` and `callVideoGenerator`
 * were not routed through any wrapper.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EXECUTOR_CTX_POLICY } from '../src/host/hostCapabilityGates.js';
import { BACKEND_FEATURES } from '../src/features/index.js';

const EXECUTOR = join(__dirname, '..', 'src', 'executor', 'executor.ts');

/** The node `ctx` object literal's top-level keys → their initializer text. */
function ctxLiteralKeys(): Map<string, string> {
  const src = readFileSync(EXECUTOR, 'utf8');
  const sf = ts.createSourceFile(EXECUTOR, src, ts.ScriptTarget.Latest, true);
  let literal: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (literal) return;
    if (ts.isVariableDeclaration(node) && node.name.getText(sf) === 'ctx' && node.type?.getText(sf) === 'NodeContext'
      && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      literal = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!literal) throw new Error('could not find `const ctx: NodeContext = { … }` in executor.ts — update this ratchet, do not delete it');
  const out = new Map<string, string>();
  const collect = (obj: ts.ObjectLiteralExpression): void => {
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        // `...(cond ? { a, b } : {})` — the conditional keys are ctx keys too.
        let e: ts.Expression = p.expression;
        while (ts.isParenthesizedExpression(e)) e = e.expression;
        if (ts.isConditionalExpression(e)) {
          for (const branch of [e.whenTrue, e.whenFalse]) {
            let b: ts.Expression = branch;
            while (ts.isParenthesizedExpression(b)) b = b.expression;
            if (ts.isObjectLiteralExpression(b)) collect(b);
            else throw new Error(`unhandled spread branch in ctx literal: ${b.getText(sf).slice(0, 80)}`);
          }
        } else if (ts.isObjectLiteralExpression(e)) {
          collect(e);
        } else {
          throw new Error(`unhandled spread in ctx literal: ${e.getText(sf).slice(0, 80)} — declare its keys explicitly`);
        }
        continue;
      }
      const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : p.name?.getText(sf);
      if (!name) continue;
      out.set(name, ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : p.getText(sf));
    }
  };
  collect(literal);
  return out;
}

function allToggleIds(): Set<string> {
  const ids = new Set<string>();
  for (const f of BACKEND_FEATURES) {
    if (f.toggleDefault) ids.add(f.toggleDefault.id);
    for (const t of f.extraToggleDefaults ?? []) ids.add(t.id);
  }
  return ids;
}

describe('G14 — every executor ctx key is declared run-context, gated, or justified core', () => {
  const keys = ctxLiteralKeys();

  it('the executor ctx key set equals EXECUTOR_CTX_POLICY', () => {
    const declared = new Set(Object.keys(EXECUTOR_CTX_POLICY));
    const undeclared = [...keys.keys()].filter((k) => !declared.has(k)).sort();
    const stale = [...declared].filter((k) => !keys.has(k)).sort();
    expect(undeclared, 'new ctx capability: declare it in host/hostCapabilityGates.ts EXECUTOR_CTX_POLICY (gate it, or justify it as core)').toEqual([]);
    expect(stale, 'policy rows for keys the executor no longer sets: remove them').toEqual([]);
  });

  it('a gated key is routed through its declared wrapper in the executor source', () => {
    for (const [key, policy] of Object.entries(EXECUTOR_CTX_POLICY)) {
      if (policy.kind !== 'gated') continue;
      const init = keys.get(key) ?? '';
      expect(init.includes(policy.wrapper), `ctx.${key} must be built through ${policy.wrapper}; got: ${init.slice(0, 120)}`).toBe(true);
    }
  });

  it('every concrete feature a gated key names is a real toggle', () => {
    const toggles = allToggleIds();
    for (const [key, policy] of Object.entries(EXECUTOR_CTX_POLICY)) {
      if (policy.kind !== 'gated') continue;
      for (const f of policy.features) {
        if (f.startsWith('<')) continue; // a per-call owner (surface id / canvas type owner)
        expect(toggles.has(f), `ctx.${key} names feature '${f}', which no feature registers as a toggle`).toBe(true);
      }
    }
  });

  it('every core / run-context row carries a reason', () => {
    for (const [key, policy] of Object.entries(EXECUTOR_CTX_POLICY)) {
      expect(policy.why.trim().length, `ctx.${key}`).toBeGreaterThan(0);
    }
  });
});
