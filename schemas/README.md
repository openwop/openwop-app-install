# Vendored OpenWOP JSON Schemas (v2 only)

This directory holds the **v2** JSON Schemas this host validates against, vendored
from the canonical [openwop/openwop](https://github.com/openwop/openwop) corpus.
Everything the backend reads lives under [`v2/`](./v2/), with `$id`s under
`https://openwop.dev/spec/v2/`.

| Path | What it is |
|---|---|
| `v2/` | The corpus `schemas/v2/` tree at the pinned tag, plus three `spec/v2/` authorities the runtime reads (`event-codemap.json`, `path-manifest.json`, `declaration.json`). |
| `CORPUS_TAG` | The corpus tag `v2/` was copied from. `scripts/check-vendored-schemas.mjs` asserts it matches the installed conformance suite. |
| `README.md` | This file. It belongs to this repo; it is not the corpus README. |

## No flat v1 tree (RFC 0266)

The corpus's flat `schemas/*.schema.json` files (and `schemas/envelopes/`) are the
**frozen v1** wire contract. v1 reached end of support on 2026-10-04 (RFC 0234),
and [RFC 0266](https://github.com/openwop/openwop/blob/main/RFCS/0266-v2-is-self-contained.md)
makes v2 self-contained: no current v2 artifact depends on frozen v1. This host
follows it. It reads no flat v1 schema at build or runtime, and the flat tree is
**not vendored**.

- `scripts/sync-schemas.sh --tag <tag>` copies only `schemas/v2/` (and removes any
  flat file an older sync left behind).
- `scripts/check-vendored-schemas.mjs` refuses a flat `schemas/*.schema.json` or
  `schemas/envelopes/`, and checks the load-bearing v2 schemas for drift.
- `scripts/check-v1-reliance.mjs` holds `flatSchemaReads` at **0**: a shipped-code
  line that spells a flat schema path, or locates `schemas/` by a flat sentinel,
  fails the gate.
- Code locates this tree with `locateRepoSchemasV2Dir()`
  (`backend/typescript/src/host/_repoPath.ts`) and compiles a schema with its
  `$ref` closure through `compileV2Schema()` (`host/v2SchemaCompile.ts`).

The frozen v1 schemas stay available as history from the corpus repository and from
the `@openwop/spec-artifacts` releases that ship them.

## Validating against the schemas

v2 schemas `$ref` their siblings (most often `ids.schema.json`), so register the
closure before compiling:

```typescript
import { compileV2Schema } from './backend/typescript/src/host/v2SchemaCompile.js';

const validate = compileV2Schema('schemas/v2', 'workflow-chain-pack-manifest.schema.json');
if (!validate(manifest)) console.error(validate.errors);
```

Any JSON Schema 2020-12 implementation works the same way: load the target schema
and every sibling it references by relative filename.
