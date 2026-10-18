# ADR 0916 — White-label adoption seams: field and recess brand tokens, feature nav translations, wrong-vendor key detection, a configurable release branch

Status: Accepted (implemented in this PR)

## Context

Five small Book AI upstream proposals (`bookai/docs/upstream-proposals.md`). In
each, a white-label distribution needs the host to expose a choice it had
hard-coded:

- **P13:** every text field's border is `--rule`. With some brand tokens that
  is 1.29:1 against `--paper`, under WCAG 1.4.11's 3:1 for a control boundary.
  Darkening `--rule` would also darken every divider.
- **P17:** `.chip--muted` and bare field captions read `--ink-3` on `--paper-2`.
  With some brand tokens that is 4.20:1, under 1.4.3's 4.5:1 for small text.
  Darkening `--ink-3` changes every muted line on `--paper`, where it already
  passes.
- **P16:** a feature's sidebar labels can carry `labelKey`/`hintKey`, but the
  `nav` namespace is the host's eager catalog. A feature's own catalog arrives
  with its lazy chunk, after the sidebar paints, so its labels stayed English.
- **P8:** the Keys page compares a pasted key with the card's `apiKeyPrefix`
  and only warns. A key saved under the wrong vendor's card fails at that vendor
  with a credential error that never says why.
- **P5:** `preflight-deploy.sh` Gate 1 and `publish-evidence.sh` hard-code
  `origin/main`. A distribution whose release branch has another name (Book AI's
  is `bookai/main`) can never deploy.

P15 (a first key for any vendor) was already done by #4909: the zero-key state
offers one button per vendor.

## Decision

- **D1 (P13): `--rule-control`.** The field rule is now `border: 1px solid
  var(--rule-control, var(--rule))`. With the token unset, the look is
  unchanged. A brand sets `--rule-control` to a 3:1 colour without touching
  dividers.
- **D2 (P17): `--ink-muted-recess`.** It is used by `.chip--muted` and by bare
  captions inside `.surface-inset` (`label:not([class])`), falling back to
  `--ink-3`.
- **Both tokens in More-contrast mode.** Both hooks are set in the ADR 0363
  More-contrast override and in the `prefers-contrast: more` query, to the same
  stronger values that mode already uses. That also gives the CSS-token gate its
  definition.
- **D3 (P16): `FrontendFeature.navMessages`.** A per-locale record merged into
  `nav` when the registry loads (`applyFeatureNavMessages`, with
  `addResourceBundle(…, deep, no-overwrite)`).
  - Keys must start with `<feature id>.`, so a feature cannot overwrite a host
    nav string.
  - A key without that prefix is dropped, not thrown, so a bad translation
    cannot brick the shell.
  - The merge runs in the ENTRY chunk, so the code is minimal. The size limit
    (8 keys of up to 160 characters per locale) is enforced by a test over the
    shipped features, not at runtime. A first draft did it at runtime and cost
    ~143 B gzip of entry headroom.
- **D4 (P8): wrong-card detection.**
  - `detectProviderByKeyPrefix` matches a pasted key against every card's
    `apiKeyPrefix`, and the longest prefix wins (`sk-ant-` beats `sk-`).
  - When the match is another card, the form says so and offers "Add it under
    <vendor>". That carries the pasted key to the right card's form.
  - It also offers "Keep it under <this>", for custom and org-scoped keys.
  - Saving without either choice is refused with a message naming both options.
  - A key that matches no prefix keeps the old soft warning.
- **D5 (P5): `OPENWOP_DEPLOY_BRANCH`.**
  - Set in `deploy.env`, default `main`.
  - Preflight Gate 1 and `publish-evidence.sh` use it.
  - A malformed value (not a branch name, or containing `..`) fails the gate.

## Alternatives

- **A defined default (`--rule-control: var(--rule)` at `:root`).** A custom
  property is computed where it is defined. A scoped redefinition of `--rule` (the
  canvas theme frames do this) would then not reach fields inside that scope. The
  fallback-at-use form follows `--rule` wherever it is redefined.
- **Block a mismatched key outright (P8).** Custom and org-scoped keys exist, so
  the confirm path stays.

## Implementation

| Part | Where |
| --- | --- |
| D1, D2 | `frontend/react/src/styles/global.css`; test `src/styles/__tests__/brandHookTokens.test.ts` |
| D3 | `frontend/react/src/features/registry.ts`; test `src/features/__tests__/featureNavMessages.test.ts` |
| D4 | `frontend/react/src/byok/keyPrefix.ts`, `KeysPage.tsx`, `byok/i18n/{en,es,fr,pt-BR}.ts`; test `src/byok/__tests__/KeysPage.keyBelongsTo.test.tsx` |
| D5 | `scripts/preflight-deploy.sh`, `scripts/publish-evidence.sh`, `scripts/deploy.env.example`; cases in `scripts/test-deploy-gates.sh` |

## Checklist

- [x] D1–D5 with tests
- [ ] Tell Book AI the PR number, so it can drop its overrides and the FU-14 edit
