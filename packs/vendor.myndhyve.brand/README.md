# `vendor.myndhyve.brand`

MyndHyve brand-workflow pack — 7 nodes covering theme + persona lifecycle.

| Pack | `vendor.myndhyve.brand` |
| peerDependencies | `host.brand: supported` |
| License | Apache-2.0 |

## Nodes (typeId-preserve)

### Theme (4)

| typeId | Pattern | Role |
|---|---|---|
| `brand.theme.implement` | State mutation via `ctx.brand.implementTheme` | side-effect |
| `brand.theme.publish` | State mutation via `ctx.brand.publishTheme` | side-effect |
| `brand.theme.review` | HITL gate via `ctx.suspend({ reason: 'conversation-input' })` | gate |
| `brand.theme.validate` | Rule-engine via `ctx.brand.validateTheme` | side-effect |

### Persona (3)

| typeId | Pattern | Role |
|---|---|---|
| `brand.persona.publish` | State mutation via `ctx.brand.publishPersona` | side-effect |
| `brand.persona.review` | HITL gate via `ctx.suspend` | gate |
| `brand.persona.validate` | Rule-engine via `ctx.brand.validatePersona` | side-effect |

## Patterns

The pack uses three composition primitives:

1. **State-mutation helper** (`applyOrPublish`) — 3 nodes (implement + 2 publish). Idempotency-keyed; host returns the resulting artifact id.
2. **HITL review factory** (`makeReview`) — 2 nodes. Optional `ctx.chat.emitCard` to surface the review dialog; suspends with `reason: 'conversation-input'` per RFC 0010 H3 ratification; decision enum `approve` / `reject` / `request-changes`.
3. **Validate factory** (`makeValidate`) — 2 nodes. Rule-engine with `failOnWarning` config; returns `passed` + `violations` array with `severity` enum.

All 7 nodes side-effectful + cacheable. Engine Layer-2 cache covers replay cost-once.

## Validate semantics

```typescript
passed = !hasErrors && (!failOnWarning || !hasWarnings)
```

Workflow authors branch on `passed: boolean`. Per-rule context surfaces in `violations[]`.

## Host contract

```typescript
ctx.brand.implementTheme({ brandId, payload, force, targetCanvasId?, idempotencyKey })
  → Promise<{ artifactId, appliedAt? }>
ctx.brand.publishTheme(...) / ctx.brand.publishPersona(...)
  → Promise<{ artifactId, appliedAt? }>
ctx.brand.validateTheme({ artifactId, ruleSet?, failOnWarning })
  → Promise<{ passed, rulesRun, violations }>
ctx.brand.validatePersona(...) // same shape
ctx.suspend({ reason: 'conversation-input', resumeKey, reviewerRole, timeoutMs? })
  → Promise<{ decision, notes?, respondent?, respondedAt?, timedOut? }>
ctx.chat.emitCard?(...) // optional UI surface for review
```

## Pipeline example

```yaml
nodes:
  - id: validate
    typeId: brand.theme.validate
    config: { ruleSet: "WCAG-AA" }
    inputs: { artifactId: "theme-1" }
  - id: review
    typeId: brand.theme.review
    config: { reviewerRole: "brand-admin" }
    inputs: { artifactId: "theme-1" }
  - id: publish
    typeId: brand.theme.publish
    inputs: { brandId: "b-1", payload: { themeId: "theme-1" } }
edges:
  - { from: validate, to: review }
  - { from: review, to: publish }
```

## See also

- [`docs/plans/MYNDHYVE-TO-OPENWOP-PACK-MIGRATION.md`](https://github.com/openwop/openwop) (in myndhyve) — Phase 3 #5
- `vendor.myndhyve.chat` — `emitCard` + `suspend` patterns
