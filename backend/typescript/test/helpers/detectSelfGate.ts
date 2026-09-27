/**
 * AST-based detection of an entitlement-choke BYPASS (ADR 0419 · GATE-4).
 *
 * A "bypass" = a bundle feature resolving its OWN toggle via `resolveOne(<own id>,
 * <request-derived subject>)` on an authenticated route, standing in for
 * `requireFeatureEnabled` and thereby skipping the central paywall choke.
 *
 * This replaces the earlier source-TEXT heuristic (`bundle-gating-invariant.test.ts`
 * history), whose documented residual false-negatives were all things a regex cannot
 * see but the type-aware AST resolves for free:
 *   1. subject bound to a variable first — `const s = subjectOf(req); resolveOne(ID, s)`
 *   2. an aliased import — `import { resolveOne as r }; r(ID, subjectOf(req))`
 *   3. an argument gap wider than the regex window
 *
 * Uses the `typescript` compiler API — already a dependency (no new package). It does
 * NOT type-check; it walks the syntax tree of each feature source, which is enough to
 * follow local `const` bindings and the import alias. The existing invariant tests are
 * the safety net against a weakening rewrite: they REQUIRE `crm`/`csm` to be detected
 * (allowlist proof) and `cdp`/`destination-sync` to be clean, so any regression in
 * this detector fails those loudly.
 */
import ts from 'typescript';

export interface SelfGateHit { file: string; snippet: string }

/**
 * Report the first own-toggle + request-derived-subject `resolveOne` call in the
 * given source, or null. `featureId` is the feature the source belongs to; `relPath`
 * is only used for the returned label.
 */
export function detectRequestSubjectSelfGate(
  source: string,
  featureId: string,
  relPath: string,
): SelfGateHit | null {
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);

  // The local name `resolveOne` is imported under (handles `import { resolveOne as r }`).
  const resolveOneLocalNames = new Set<string>();
  // const bindings: name → initializer node (to trace `const s = subjectOf(req)` and
  // `const TOGGLE_ID = 'crm'` / `const FEATURE = { toggleId: 'crm' }`).
  const constInit = new Map<string, ts.Expression>();

  // Iterative walk (an explicit stack, not recursion) — some feature sources are deep
  // enough (long chained expressions, large object literals) to overflow a recursive
  // `forEachChild`. `pushChildren` collects one node's children onto the work stack.
  const pushChildren = (node: ts.Node, stack: ts.Node[]): void => {
    ts.forEachChild(node, (c) => { stack.push(c); });
  };

  const collectStack: ts.Node[] = [sf];
  while (collectStack.length > 0) {
    const node = collectStack.pop()!;
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const el of node.importClause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (imported === 'resolveOne') resolveOneLocalNames.add(el.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constInit.set(node.name.text, node.initializer);
    }
    pushChildren(node, collectStack);
  }
  if (resolveOneLocalNames.size === 0) return null; // this file never calls resolveOne

  // Resolve an expression to a string-literal toggle id, following one const hop and
  // `OBJ.toggleId` where OBJ is `const OBJ = { toggleId: '<id>' }`.
  const toggleIdOf = (expr: ts.Expression): string | null => {
    if (ts.isStringLiteralLike(expr)) return expr.text;
    if (ts.isIdentifier(expr)) {
      const init = constInit.get(expr.text);
      return init && ts.isStringLiteralLike(init) ? init.text : null;
    }
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'toggleId' && ts.isIdentifier(expr.expression)) {
      const obj = constInit.get(expr.expression.text);
      if (obj && ts.isObjectLiteralExpression(obj)) {
        for (const p of obj.properties) {
          if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'toggleId' && ts.isStringLiteralLike(p.initializer)) {
            return p.initializer.text;
          }
        }
      }
    }
    return null;
  };

  // Is this subject expression REQUEST-derived (⇒ bypass) rather than RESOURCE-derived
  // (`{ tenantId: org.tenantId }` ⇒ the legitimate ADR 0176 public-route exemption)?
  // Follows one const hop so `const s = subjectOf(req)` is seen through.
  const isRequestDerived = (expr: ts.Expression): boolean => {
    let e: ts.Expression = expr;
    if (ts.isIdentifier(e)) {
      const init = constInit.get(e.text);
      if (init) e = init;
    }
    const text = e.getText(sf);
    if (/\borg\.tenantId\b/.test(text)) return false; // resource-derived → public, fine
    return /\bsubjectOf\s*\(/.test(text) || /\breq\b/.test(text);
  };

  const visitStack: ts.Node[] = [sf];
  while (visitStack.length > 0) {
    const node = visitStack.pop()!;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && resolveOneLocalNames.has(node.expression.text) && node.arguments.length >= 2) {
      const id = toggleIdOf(node.arguments[0]);
      if (id === featureId && isRequestDerived(node.arguments[1])) {
        return { file: relPath, snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 100) };
      }
    }
    pushChildren(node, visitStack);
  }
  return null;
}
