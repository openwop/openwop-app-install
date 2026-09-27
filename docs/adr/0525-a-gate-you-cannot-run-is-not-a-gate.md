# ADR 0525 — A gate you cannot run is not a gate

Status: implemented (2026-08-05)

Phase D of the ADR 0523/0524 plan: coverage and honesty debt. Four independent
items, ruled on together by `/architect`.

## The thread connecting all four

Each item is a **check that could not detect what it claimed to check**:

- a CI gate that existed only as an inline heredoc, so nobody could run it;
- a baseline that granted standing permission to six undiagnosed conditions;
- a module with no test at all, guarding a file the product tells users to publish;
- ten SQL probes that return zero rows because their predicate is wrong — while
  "zero rows" is exactly what they declare healthy.

**A broken check reads as a passing check.** That is the shape.

## D4 — the red `packs-check` (openwop-registry PR #42)

26 pack-internal schema `$id`s across **11** agent packs pinned an older version
than their pack's `version`. Two were mine, from publishing `deep-research`
1.0.1→1.0.3 without regenerating its `$id`s.

**Rewrite in place, do not bump 11 versions.** `CONTRIBUTING.md` already
prescribes exactly this. A version bump is a distribution event with pin
consequences; spending 11 to correct a metadata string in unchanged documents is
a far larger action, and it would recreate the problem on the next bump. Verified
before choosing: **every affected schema is byte-identical to its published copy
modulo the `$id` string.** So source is corrected; published tarballs stay
immutable (re-cutting one breaks its `integrity` hash) and the served mirror is
left alone — a mirror that improves on its artifact becomes a second source of
truth, and with byte-identical content a `$id`-keyed cache coalescing versions is
*correct*.

**The bigger defect: the gate could not be run.** It lived only as an inline
`node -e` heredoc in `packs-check.yml` — unrunnable locally, untestable,
unprobeable, and absent from `registry-check.sh` (the repo's own `npm run check`).
The only way to observe it was to push. That is why a routine bump left `main`
red for four days. Extracted to `scripts/check-pack-schema-ids.mjs`, called from
both, with `--fix`.

`CONTRIBUTING.md` also claimed `precheck-packs.mjs` SHOULD catch this drift. **It
does not check `$id` at all.** An unrunnable gate plus a false claim pointing at a
different gate is how it stayed invisible. Corrected.

> **Two of my premises were wrong and `/architect` caught both:** 13 packs (it is
> 11), and "red by default" (it was green until 2026-08-01 22:55 — it went red on
> the first version-bump publish).

### The same drift, larger, in this repo

Bumping the four node packs I touched surfaced that **openwop-app carries 122
drifts across 17 packs** — a larger population than the registry's 26, because
this is where node packs are *authored* and the registry only sees them at
publish time. Same ruling applied, gate ported, wired into `scripts/ci.sh`.

I nearly created the same drift myself: I had changed node-pack schemas *without*
bumping their versions, which would have made the vendored copy diverge from the
published one at the same version — precisely the class I had just fixed next
door.

## D3 — `GRD-8`: six baseline entries, diagnosed rather than carried

**A baseline entry is a standing grant of permission to an undiagnosed
condition.** Diagnosing these took one pass and turned up a live defect.

The decision procedure needed **four** read sites, not "grep the pack's
`index.mjs`" — the host registry resolves *before* the pack resolver, so a
host-implemented node means the pack impl never runs; and a key can be honoured
by the chain loader's pre-flight, or by a registration-time rewriter that
consumes and then deletes it.

| Key | Verdict |
|---|---|
| `openapi-call.config.connectionRef` | schema gap — read by the loader's `chainRequirements()` |
| `chatCompletion.config.modelClass` | schema gap — resolved then deleted at registration |
| `web.search.config.suitability` / `inputs.suitability` | schema gap — node reads config-or-inputs (ADR 0502) |
| `web.search.inputs.maxResults` | **dead — LIVE DEFECT** |
| `web.search.config.query` | dead — pure duplication |
| `kv-{get,set}.config.key` | schema gap — the delegate spreads config into the host call |

**The live defect:** `core.web.search` read `config.maxResults` only, while its
sibling `suitability` reads config-or-inputs *thirteen lines below in the same
function*. `kicktodo.research` and `openwop-app.kicktodo.challenge-factory` both
ask for 8 results via `inputs` and **silently ran at the default 5**. Honoured
rather than deleted, matching the ADR 0502 precedent — deleting the key would
quietly ratify a value loss the author intended.

Baseline is now **empty**, and probed: it still bites with nothing to grandfather.

## D2 — `chainPackManifest` had no test

**Honest framing: a ratchet over already-correct behaviour, not a bug-find.** A
grade pass had verified by hand that the export validates and round-trips — but a
review artifact is not a test, and this module changed more than any other in ADR
0523.

Split, because placement was forced rather than preferred: ajv is not a frontend
dependency and the chain loader is backend-only, so the validation and expansion
halves live in a backend test. Re-implementing either in the frontend would be
the second copy the architecture contract forbids.

**The wrong-reason trap the backend half is built around:**
`loadWorkflowChainPacks` **returns** `{ errors }` — it does not throw. A test that
writes a manifest, calls the loader and asserts "no exception" passes on a totally
invalid manifest. So the assertions are `errors.length === 0`, the chain
**resolves** by id, and expansion **preserves** `config` and `inputs`.

**It did find one real defect.** A 300-character workflow name produced a
316-character pack name, exceeding the manifest schema's `maxLength: 256` — an
export that fails its own schema, discovered only at publish time, holding a file
the app told the user to PR. Slug now capped.

> A caution recorded because it nearly produced a false finding: my first draft
> asserted npm's 214-char limit and a looser name pattern. Both were invented.
> The real constraints came from
> `schemas/workflow-chain-pack-manifest.schema.json` — **an invented constraint
> produces an invented finding**, so the assertion has to come from the SSoT.

## D1 — ten steward probes that cannot match

`docs/steward/DATA-ASSESSMENT*.md` records SQL probes against `host_ext_kv`, each
with an expectation — usually "expect 0". A `[x]` is an assertion that something
was measured.

**Fixing the prose was already tried and failed.** A correction block written
2026-08-03 named two offending lines, diagnosed the cause and gave the correct
predicate. **Neither source line was ever edited.** The author of that correction
then wrote a fresh non-executable probe in the same file. Knowing the keyspace is
not the failing skill — never executing the query is. That is why this ships a
**gate**, not another correction note.

`scripts/check-steward-probes.mjs` derives the valid keyspaces from source
(`new DurableCollection('<ns>')` registrations and `KEY_PREFIX` literals) rather
than a hand list, and checks column names against the real table.

It found and fixed four genuine defects: both `wfreg` probes (a flat `wfreg:` key,
not a `hostext:` collection — including **`PROBE-CP1`, a PII probe**), a namespace
transcribed from memory, and one using columns `key`/`value` that do not exist.

**One box was un-checked.** `DATA-ASSESSMENT-dashboard-program.md` `PROBE-1`
carried `(run 2026-07-16: 1 row — healthy)` for SQL that names non-existent
columns and applies a jsonb operator to a TEXT column. That statement cannot have
executed. Either a different query was run — making the recorded result
unreproducible — or the result was never obtained. Predicate corrected; **the box
stays open until someone actually runs it.**

> **The gate over-reported at first**, flagging 24. Collection names may CONTAIN
> colons (`workflow:ownership` → `hostext:workflow:ownership:…`), so matching the
> first colon-delimited segment produced false positives on correct probes; and
> `hostext:%…` is a deliberate leading wildcard, not a keyspace claim. Both fixed
> before trusting any output — a gate that cries wolf gets ignored, which is how
> you end up with an unrunnable one.

## What the grade trio found — including in my own remedies

**The steward gate accepted any PREFIX of a real collection name**, so truncating
`podcast-episode:` by one character stayed green. Its docblock admitted only that
a probe with a *correct* prefix could still be wrong — while the matcher was also
accepting *incorrect* ones, making the admission understated rather than accurate.
Family wildcards now match on a **segment boundary**. It also saw only `k LIKE`,
so `k =`, `k ~`, `starts_with(k, …)` and the WHERE line of a fenced block were
invisible — including the very column class the docblock claimed to "kill".
Coverage went 28 → 49 → **81 lines**. Re-probed: a typo'd namespace now fails.

**The schema-`$id` gate counted schemas AFTER the `$id` test**, so *deleting* an
`$id` both silenced its drift and shrank the number the anti-vacuity floor
watches — removing the field was a way to go green. Counting moved before the
test, which surfaced **64 schemas with no `$id` at all** across this repo (60 in
the registry). Normatively required, so it is reported — but as a **no-growth
ceiling**, not a hard failure: blocking every unrelated change on a 64-case
pre-existing population is the mistake ADR 0504 records me *not* making once
before. Measured, then bounded.

**The `maxResults` fix still lost a correctly-filled value.** `usable()` required
`typeof v === 'number'`, but `chainPackManifest` declares exported params
`type: 'string'` and embedded tokens coerce to string — so an author who
correctly enters 8 delivers `'8'`, which fell back to 5. The same silent loss the
fix exists to close, surviving one layer along. Now accepts a numeric string.

**My behaviour test's stub had already drifted** from the thing it stood in for —
it omitted `query` from the call shape and passed anyway, because
`execute(ctx as never)` disabled every structural check. Typed properly, `query`
pinned, and the numeric-string route covered.

**Two of my own copy fixes were regressions.** The per-parameter help text lost
the parameter NAME (a five-input form showed the same paragraph five times) and
promised an outcome `RunInputsDialog` actively prevents. Both descriptions also
still opened with `${label}.`, which the gallery card renders as the heading
directly above — the restate-the-label defect, now able to restate 400
characters.

**Two comments I wrote asserted constraints that do not exist:** a `maxLength` on
the chain-level `description` (only the top-level one is bounded), and a
justification citing a preflight block that the preflight explicitly never does.

### The generator, found by grade-data

`/grade-data`'s **own skill file** prescribed
`SELECT split_part(k,':',2) …` as the cross-check that makes a zero
trustworthy — wrong for exactly the colon-containing collection names the same
paragraph warns about, and doubly wrong because a `hostext:<name>:<id>` key has
**no tenant segment at all**. Every `split_part(k,':',3) AS tenant` probe in the
corpus was written against a key shape that does not exist: two returned 100% of
rows while claiming to detect an impossible defect, and one manufactured a
cross-org-bleed finding. **Fixing the ten probes without fixing the skill would
have regenerated them on the next audit.** Corrected in the skill.

Four more probes carried `[x]` with no result, date or database at all — unchecked.

## What this deliberately does NOT do

- **Execute probes against a seeded fixture.** That is the only layer that catches
  a probe with correct columns and a correct prefix that is still wrong — a
  value-field condition written as a key predicate, or a `split_part` index off by
  one. Deferred behind a **measurement gate**: build the static layer, see what it
  actually catches, then decide. Stated in the script's own docblock so nobody
  over-trusts it.
- **Catch Postgres-only type errors** (`jsonb` operators on a TEXT column). A
  sqlite fixture would mask them — the documented
  sqlite-masks-Postgres-type-errors class.
- **Narrow the `$id` rule** so a byte-identical document may keep the `$id` of the
  version that first published it. That is more truthful, and it is a normative
  contract change in a second repo motivated by un-redding CI — the worst reason
  to edit a spec. Filed; decide cold.
- **Validate the export at download time.** `BuilderShell` blobs the manifest
  straight to the user with no validation. A test proves the exporter is correct
  today; it does not stop a future invalid export reaching someone.

## Open

- `openapi-call` advertises `connectionRef` at pre-flight and renders a Connect
  chip, but at execution does a bare fetch with **no credential resolution** — six
  nodes advertise a requirement the node never uses. An "advertise only what is
  behaviourally honoured" violation, larger than GRD-8.
- `modelClass` resolution runs only via the app-builder post-process, so a
  user-instantiated gallery copy gets none — the key is inert there (degrades
  safely onto the authored `provider`/`model`).
- The four node packs bumped here need publishing + repinning before the schema
  declarations reach production.

## RFC gate

**No RFC.** Node-pack schema declarations and steward docs are not the wire.
`CONTRIBUTING.md` in `../openwop` is a contributor contract, corrected for
accuracy rather than changed in substance.
