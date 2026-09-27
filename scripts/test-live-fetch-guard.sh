#!/usr/bin/env bash
#
# Tests for the ADR 0661 live-fetch guard.
#
# This repo has shipped five entry guards that never ran, two of them merge gates
# that could not fail. A guard whose FIRING arm has never been observed does not
# get to merge — so both arms run a real vitest against temporary fixtures:
#
#   arm 1  a NON-allowlisted test that fetches  -> fails, and names ADR 0661
#   arm 2  an ALLOWLISTED test that fetches     -> passes (today's 87 keep working)
#   arm 3  the guard does not break an ordinary test that never fetches
#   arm 4  a component-shaped `try { await fetch() } catch {}` CANNOT swallow it
#
# The fixtures are created under src/ (vitest only sees that tree) and removed on
# exit, including on failure.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE="$ROOT/frontend/react"
DIR="$FE/src/__livefetchguard__"
LIST="$FE/test-live-fetch-allowlist.txt"
LIST_BAK="$(mktemp)"
fails=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; fails=$((fails + 1)); }

cleanup() { rm -rf "$DIR"; [ -f "$LIST_BAK" ] && cp "$LIST_BAK" "$LIST"; rm -f "$LIST_BAK"; }
trap cleanup EXIT
cp "$LIST" "$LIST_BAK"

mkdir -p "$DIR"
# NETWORK ERRORS ARE SWALLOWED HERE ON PURPOSE. A bare `await fetch(...)` to a
# closed port fails whether or not the guard is wired, so this arm would pass
# with the guard REMOVED — a check that cannot fail, in the harness for a change
# about checks that cannot fail. Caught by unwiring the guard and watching this
# arm stay green. Only the guard's own error is allowed to escape.
cat > "$DIR/denied.test.ts" <<'TEOF'
import { it } from 'vitest';
it('issues a live fetch', async () => {
  try { await fetch('http://127.0.0.1:9/adr0661'); }
  catch (e) { if (String(e).includes('ADR 0661')) throw e; }
});
TEOF
# The allowed fixture must not merely "not throw": a fetch to a closed port fails
# with an ordinary connection error whether or not the guard let it through, so a
# bare `await fetch(...)` would fail this arm for the wrong reason (it did, first
# run). Assert on WHICH error arrives — reaching the real network is the property
# under test.
cat > "$DIR/allowed.test.ts" <<'TEOF'
import { it, expect } from 'vitest';
it('is allowed to reach the network', async () => {
  let err: unknown;
  try { await fetch('http://127.0.0.1:9/adr0661'); } catch (e) { err = e; }
  expect(String(err)).not.toContain('ADR 0661');   // the guard did not block it
  expect(err).toBeDefined();                       // it really went to the network
});
TEOF
cat > "$DIR/inert.test.ts" <<'TEOF'
import { it, expect } from 'vitest';
it('never fetches', () => { expect(1 + 1).toBe(2); });
TEOF

vitest_one() { ( cd "$FE" && node node_modules/vitest/vitest.mjs run "src/__livefetchguard__/$1" >/dev/null 2>&1; echo $? ); }

# arm 1 — not on the list
rc=$(vitest_one denied.test.ts)
[ "$rc" != "0" ] && ok "a non-allowlisted live fetch FAILS the test" \
                 || bad "a non-allowlisted live fetch passed — the guard did not fire"

out=$( ( cd "$FE" && node node_modules/vitest/vitest.mjs run src/__livefetchguard__/denied.test.ts 2>&1 ) )
grep -q 'ADR 0661' <<<"$out" && ok "  ...and the failure names ADR 0661 and the cause" \
                                        || bad "the failure did not mention ADR 0661 (an unattributed throw teaches nothing)"

# arm 2 — on the list
printf 'src/__livefetchguard__/allowed.test.ts\n' >> "$LIST"
rc=$(vitest_one allowed.test.ts)
[ "$rc" = "0" ] && ok "an ALLOWLISTED live fetch still passes (the 87 keep working)" \
                || bad "an allowlisted live fetch failed — this would red 87 files"
cp "$LIST_BAK" "$LIST"

# arm 4 — the swallow hole. Every one of the 87 lives inside code that already
# handles a failed read, so a guard that only throws would be caught by the very
# branch the defect creates and would report nothing.
cat > "$DIR/swallowed.test.ts" <<'TEOF'
import { it, expect } from 'vitest';
it('swallows the failure exactly like a component does', async () => {
  try { await fetch('http://127.0.0.1:9/adr0661'); } catch { /* handled, as a feature would */ }
  expect(true).toBe(true);
});
TEOF
rc=$(vitest_one swallowed.test.ts)
[ "$rc" != "0" ] && ok "a swallowed live fetch still FAILS (asserted after the test body)"                  || bad "a try/catch swallowed the guard — it cannot fire on the shape it exists for"

# arm 5 — the guard must not CLOBBER a file's own module-scope fetch stub.
# This arm exists because the first implementation re-armed in `beforeEach`, and
# setup-file `beforeEach` runs AFTER a test file's module body — so it destroyed
# every `vi.stubGlobal('fetch', …)` and sent those calls to the real network,
# reporting two files as violators whose entire purpose is that they stub fetch.
# The harness passed that build 5/5; only the full 756-file suite caught it.
# A guard that manufactures the defect it detects is the worst outcome available,
# so it gets its own arm.
cat > "$DIR/stubbed.test.ts" <<'TEOF'
import { it, expect, vi } from 'vitest';
const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
vi.stubGlobal('fetch', fetchMock);
it('keeps its own module-scope stub', async () => {
  const res = await fetch('http://127.0.0.1:9/adr0661');
  expect(res.status).toBe(200);
  expect(fetchMock).toHaveBeenCalled();
});
TEOF
rc=$(vitest_one stubbed.test.ts)
[ "$rc" = "0" ] && ok "a file's own vi.stubGlobal('fetch') is NOT clobbered by the guard"                 || bad "the guard clobbered a module-scope fetch stub — it would manufacture violations"

# arm 6 — an entry carrying an inline reason (`path  # why`) is STILL allowlisted.
# The stale-check exemption (ADR 0661 phase 2) added `# reason` to the file's
# grammar, and all three readers had to learn it. If THIS reader did not, an
# annotated entry's path would no longer match and the guard would fire on a file
# the list deliberately permits — turning a fix for a false red into a real one.
printf 'src/__livefetchguard__/annotated.test.ts  # racy: does not fetch every run\n' >> "$LIST"
cp "$DIR/allowed.test.ts" "$DIR/annotated.test.ts"
rc=$(vitest_one annotated.test.ts)
[ "$rc" = "0" ] && ok "an entry with an inline '# reason' is still allowlisted" \
                || bad "the inline reason broke path matching — the guard fires on a permitted file"
cp "$LIST_BAK" "$LIST"

# arm 3 — no collateral damage
rc=$(vitest_one inert.test.ts)
[ "$rc" = "0" ] && ok "a test that never fetches is unaffected" \
                || bad "the guard broke a test that makes no network call"

printf '\n'
if [ "$fails" -eq 0 ]; then printf '\033[32m✓ live-fetch guard: all arms pass\033[0m\n\n'; exit 0; fi
printf '\033[31m✗ live-fetch guard: %d assertion(s) failed\033[0m\n\n' "$fails"
exit 1
