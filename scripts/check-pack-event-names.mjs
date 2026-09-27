#!/usr/bin/env node
/**
 * Every literal `eventName` in a chain pack must name a PROTOCOL event or carry
 * a REGISTERED vendor org. Templates (`{{params.…}}`) are the pack saying "the
 * installing host supplies this", and skip.
 *
 * WHY MEMBERSHIP AND NOT GRAMMAR — the whole point, and it is `openwop-1`'s
 * argument from crosstalk `dd4b` mechanised. A protocol event is spelled
 * `run.started`: two kebab segments, no `openwop.` prefix — character for
 * character the shape of a vendor type. Grammar alone accepts `node.progres` as
 * a perfectly fine vendor name, and a typo of a protocol event then travels as
 * opaque vendor data that nothing ever reports. Only codemap membership
 * separates "a vendor event I should carry" from "a protocol event somebody
 * misspelled".
 *
 * WHY A CHAIN PACK MUST NOT HARDCODE ONE AT ALL (`1892`): the event belongs to
 * the INSTALLING HOST, not to the pack. A pack that names a host event is
 * binding a name it does not own. Template it and let the host supply it.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODEMAP = join(ROOT, 'schemas', 'v2', 'event-codemap.json');
const DECLARATION = join(ROOT, 'schemas', 'v2', 'declaration.json');

if (!existsSync(CODEMAP) || !existsSync(DECLARATION)) {
  // An absent corpus tree would make every check vacuously green — the exact
  // empty-and-passing shape this repo keeps finding in its own gates.
  console.error('✗ check-pack-event-names: the vendored v2 corpus tree is missing; refusing to report green.');
  process.exit(1);
}

const named = new Set();
(function collect(o) {
  if (Array.isArray(o)) { o.forEach(collect); return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') { named.add(k); named.add(v); } else collect(v);
  }
})(JSON.parse(readFileSync(CODEMAP, 'utf8')));

const registered = new Set(Object.keys(JSON.parse(readFileSync(DECLARATION, 'utf8')).extensions ?? {}));

/** `events.md` §Types — the vendor branch. */
const VENDOR = /^(?!openwop\.)[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)?$/;
const TEMPLATE = /^\{\{\s*params\.[A-Za-z0-9_]+\s*\}\}$/;

function packFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...packFiles(p));
    else if (e.name === 'pack.json') out.push(p);
    else if (statSync(p).isFile() && e.name.endsWith('.json') && dir.includes('workflow-chain')) out.push(p);
  }
  return out;
}

const files = [...packFiles(join(ROOT, 'examples', 'workflow-chain-packs')), ...packFiles(join(ROOT, 'packs'))];

/**
 * Names this repo KNOWS are wrong and has not yet moved. SHRINK-ONLY: a name
 * here that has become valid fails the gate as a stale admission, exactly like
 * `conformance-v2-known-red.txt`. Each carries the reason it is still here,
 * because a bare allowlist is a gate that tolerates what it never mentions.
 */
const ADMITTED = new Map([
  ['host.crm.contact.created',
   'emitted from 25 files; the rename is its own change (ADR 0682 shape). The pack no longer HARDCODES it — this is the parameter default, so moving the emitter is a one-line follow-up here.'],
  ['host.users.user.deactivated',
   'emitted from 17 files via USER_DEACTIVATED_EVENT; same follow-up as above.'],
  ['host.forms.submission.created',
   'HANDED BACK to openwop-1 (crosstalk 180c). Renaming it leaves forms-intake-chain-execution 4/9 red with the chain firing, the run completing and nothing filed — five hypotheses falsified, cause not found. Do NOT rename without re-running that test.'],
]);

const findings = [];
const admittedSeen = new Set();
let literals = 0;
let templates = 0;

/** One name, one verdict — used for both `eventName` and the parameter default,
 *  because templating a binding MOVES the name into the default and a gate that
 *  only read `eventName` would go green on the change that hid it. */
function check(name, file, where) {
  const rel = file.slice(ROOT.length + 1);
  if (named.has(name)) return;                       // a protocol event
  if (ADMITTED.has(name)) { admittedSeen.add(name); return; }
  if (!VENDOR.test(name)) { findings.push({ rel, name, where, why: 'not a valid vendor type (events.md §Types)' }); return; }
  const org = name.split('.')[0];
  if (!registered.has(org)) findings.push({ rel, name, where, why: `org \`${org}\` is not registered in spec/v2/declaration.json` });
}

for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  for (const m of text.matchAll(/"triggerEventName"\s*:\s*\{[^}]*?"default"\s*:\s*"([^"]*)"/g)) {
    check(m[1], f, 'parameter default');
  }
  for (const m of text.matchAll(/"eventName"\s*:\s*"([^"]*)"/g)) {
    const name = m[1];
    if (TEMPLATE.test(name)) { templates += 1; continue; }
    literals += 1;
    check(name, f, 'eventName');
  }
}

// Shrink-only: an admission that no longer matches anything is stale and must go.
for (const [name] of ADMITTED) {
  if (!admittedSeen.has(name)) {
    findings.push({ rel: 'scripts/check-pack-event-names.mjs', name, where: 'ADMITTED', why: 'STALE admission — this name no longer appears; delete the line' });
  }
}

// A scan that matched nothing is a broken query, not a clean repo.
if (literals + templates === 0) {
  console.error('✗ check-pack-event-names: found NO `eventName` bindings at all — the scan is broken, not the packs.');
  process.exit(1);
}

console.log(`▶ check-pack-event-names: ${literals} literal binding(s), ${templates} templated, across ${files.length} pack file(s)`);
if (findings.length === 0) {
  console.log(`✓ every literal names a protocol event or a registered vendor org (${named.size} codemap names, ${registered.size} registered orgs).`);
  process.exit(0);
}
console.error(`\n✗ ${findings.length} chain-pack event binding(s) name something no conformant host may emit:\n`);
for (const f of findings) console.error(`  ${f.rel}\n    "${f.name}" — ${f.why}`);
console.error('\n  A chain pack should not hardcode a host event at all: the event belongs to the');
console.error('  INSTALLING HOST, not the pack. Use "{{params.<name>}}" and let the host supply it.');
process.exit(1);
