/**
 * RATCHET — a catch that writes `[]` into a list state with NO sibling failed/error
 * flag (ADR 0779 D7; the RTP-EMPTY-1 / EMPTY-ON-FAIL-1..8 class).
 *
 * THE CLASS. A list read rejects, the catch sets the list to `[]`, and the render
 * cannot tell "the server said none" from "we never heard back", so it shows the
 * "you have none" empty-state copy. RTP-EMPTY-1 was the first instance; the
 * /grade-tests wave-48 audit (`catch-empty-audit.md`, 2026-10-15) found eight more,
 * fixed alongside this file.
 *
 * WHAT THIS PINS. Every catch body (`.catch(...)` in any form, or `catch { }`) that
 * calls `setX([])` and calls NO sibling flag setter in the same body (a setter whose
 * name contains Fail / Error / Err / Unreadable / Unknown, or `setX('failed' |
 * 'error')`). Such a site is SILENT: it cannot render an honest failure. Each
 * existing one is listed in ALLOWED with its audit verdict. A NEW silent site fails
 * this test; so does a removed one (the list is pinned, shrink-only: delete the
 * entry when you fix a site).
 *
 * WHAT IT DOES NOT CLAIM — read before trusting a green run.
 * 1. A FLAGGED site is not proven honest. Five of the eight wave-48 defects
 *    (EMPTY-ON-FAIL-1, -4, -5, -6, -8) DID set an error beside the `[]` and still
 *    rendered the empty copy, because the render never checked the flag. Only a
 *    per-component test catches that; each fix has one (`*.readFailure.test.tsx`).
 * 2. It sees only an empty write in the catch itself. A `?? []` coalesce at render,
 *    or a `.catch(() => [])` feeding a later setter, is invisible here (see
 *    `scripts/check-failed-read-sentinels.mjs` notes 3–4 for those shapes).
 * 3. A flag with a name outside the pattern above (a local `let failed`, a state
 *    machine named differently) reads as silent. Three audited OK-FLAGGED sites are
 *    in ALLOWED for exactly that reason, and say so.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');

/** file:setter → how many silent catch sites it holds, with the audit verdict. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'builder/pair/FirstDraft.tsx:setChains': { count: 1, why: 'OK-SILENT: starter-chain chips row hidden' },
  'byok/SubscriptionCredentialCard.tsx:setProviders': { count: 1, why: 'OK-SILENT: card hidden, same as "host advertises none"' },
  'chat/CompareView.tsx:setSessions': { count: 1, why: 'OK-SILENT: compare-with <select> just has fewer options' },
  'chat/SlashInputsPanel.tsx:setVariables': { count: 1, why: 'OK-SILENT: commented deliberate; dispatch legacy path applies' },
  'chat/voice/VoiceAgentPicker.tsx:setBoards': { count: 1, why: 'OK-SILENT: boards optional; the roster failure is stated separately (EMPTY-ON-FAIL-3)' },
  'chrome/PinnedAgentsNav.tsx:setAgents': { count: 1, why: 'OK-SILENT: nav extra hidden; unpin-on-failure guarded' },
  'chrome/VendorSetupPrompt.tsx:setProviders': { count: 1, why: 'OK-SILENT: prompt stays hidden' },
  'features/cms/CmsLanguageSettings.tsx:setMembers': { count: 1, why: 'OK-SILENT: UserPicker options; grant name falls back to subject' },
  'features/cms/CmsPage.tsx:setAssets': { count: 1, why: 'OK-SILENT: media fields degrade to a free-text token input' },
  'features/cms/SectionsEditor.tsx:setTaxonomies': { count: 1, why: 'OK-SILENT: taxonomy <select> options only' },
  'features/commerce/CommercePage.tsx:setProducts': { count: 2, why: 'NOT IN THE W48 AUDIT: secondary product reads beside the quotes / price-lists tabs (their primary reads are flagged)' },
  'features/dashboard/tiles/TodosTile.tsx:setCards': { count: 1, why: 'OK-FLAGGED (audit): `state` is checked before the empty copy; flag name outside the pattern' },
  'features/entities/EntitiesPage.tsx:setTaxonomies': { count: 1, why: 'OK-FLAGGED (audit): local `taxFailed` → `termsFailed` warning' },
  'features/marketplace/BundleShopPage.tsx:setCommerce': { count: 1, why: 'OK-FLAGGED (audit): `commerceUnavailable` warning' },
  'features/marketplace/CreditPacksStrip.tsx:setPacks': { count: 1, why: 'OK-SILENT: strip returns null' },
  'features/priority-matrix/PriorityMatrixPage.tsx:setPresets': { count: 1, why: 'OK-SILENT: falls back to built-in preset options' },
  'features/publishing/PublishingPage.tsx:setAssets': { count: 1, why: 'OK-SILENT: OG-image <select> options only' },
  'features/sales-commissions/CommissionsPage.tsx:setMembers': { count: 1, why: 'OK-SILENT: UserPicker options; name falls back to subject' },
  'features/service-desk/SupportPage.tsx:setAssignees': { count: 1, why: 'OK-SILENT: commented enrichment; the ticket read has `rowsFailed`' },
  'features/service-desk/SupportPage.tsx:setMe': { count: 1, why: 'OK-SILENT: same enrichment read as setAssignees' },
  'orgs/UserPicker.tsx:setFetched': { count: 1, why: 'OK-SILENT: documented; the existing value is kept as its own option' },
};

/** Comments are not code. Strings are skipped over (so `'https://…'` is not a
 *  comment) but kept, so a `setState('failed')` sentinel stays visible. */
function stripComments(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < s.length && s[i] !== c) {
        if (s[i] === '\\') { out += s[i]; i++; }
        out += s[i] ?? ''; i++;
      }
      out += c; i++;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** The balanced `( … )` or `{ … }` starting at `start`. */
function balanced(s: string, start: number): string {
  const open = s[start];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return s.slice(start, i + 1);
  }
  return s.slice(start);
}

/** A failure-path setter that RAISES the flag. Its argument must not be a clearing
 *  value: `setXFailed(false)` / `setError(null)` in a catch is not a failure flag, and
 *  matching on the setter NAME alone let such a catch pass as flagged (wave 51 probe
 *  w51g1-ce-flag-cleared). Re-measured 2026-10-16 with this pattern: 21 keys / 22
 *  sites, identical to ALLOWED — no site depended on a clearing call. */
const FLAG = /\bset\w*(Fail|Error|Err|Unreadable|Unknown)\w*\s*\(\s*(?!false\b|null\b|undefined\b|''|""|\))/;
const FLAG_SENTINEL = /\bset\w*\(\s*['"](failed|error)['"]/;

/** Setter names of the silent `setX([])` writes in one source text, one per catch. */
function silentEmptyWrites(raw: string): string[] {
  const code = stripComments(raw);
  const found: string[] = [];
  const re = /\.catch\s*\(|\bcatch\s*(\([^)]*\)\s*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const at = m.index + m[0].length - 1;
    const body = balanced(code, at);
    const empties = new Set([...body.matchAll(/\b(set[A-Z]\w*)\(\s*\[\]\s*\)/g)].map((x) => x[1] ?? ''));
    if (empties.size === 0 || FLAG.test(body) || FLAG_SENTINEL.test(body)) continue;
    for (const e of empties) found.push(e);
  }
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === '__testing__') continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function scan(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/');
    for (const setter of silentEmptyWrites(readFileSync(file, 'utf8'))) {
      const key = `${rel}:${setter}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

describe('the scanner sees every catch form (so a green run is not vacuous)', () => {
  it('counts the arrow, brace and try/catch forms', () => {
    expect(silentEmptyWrites('x.catch(() => setA([]));')).toEqual(['setA']);
    expect(silentEmptyWrites('x.catch(() => { if (live) setB([]); });')).toEqual(['setB']);
    expect(silentEmptyWrites('try { await f(); } catch { setC([]); }')).toEqual(['setC']);
    expect(silentEmptyWrites('try { await f(); } catch (e) { setD([]); }')).toEqual(['setD']);
  });

  it('does not count a catch that also sets a failed/error flag, or commented code', () => {
    expect(silentEmptyWrites('x.catch(() => { setA([]); setAFailed(true); });')).toEqual([]);
    expect(silentEmptyWrites('x.catch((e) => { setError(String(e)); setB([]); });')).toEqual([]);
    expect(silentEmptyWrites("x.catch(() => { setC([]); setState('failed'); });")).toEqual([]);
    expect(silentEmptyWrites('// x.catch(() => setD([]));')).toEqual([]);
  });

  it('a catch that CLEARS its flag is still silent (the flag must be raised, not merely named)', () => {
    expect(silentEmptyWrites('x.catch(() => { setA([]); setAFailed(false); });')).toEqual(['setA']);
    expect(silentEmptyWrites('x.catch(() => { setB([]); setError(null); });')).toEqual(['setB']);
    expect(silentEmptyWrites('x.catch(() => { setC([]); setLoadError(); });')).toEqual(['setC']);
    // Positive controls: a raised flag in the same shapes is still recognised.
    expect(silentEmptyWrites('x.catch(() => { setA([]); setAFailed(true); });')).toEqual([]);
    expect(silentEmptyWrites('x.catch((e) => { setB([]); setError(String(e)); });')).toEqual([]);
  });
});

describe('ADR 0779 D7 — silent catch-to-[] sites are pinned (shrink-only)', () => {
  const found = scan();

  it('no NEW silent catch-to-[] site (give the read a failed flag, or add a reviewed entry with its reason)', () => {
    const over = Object.entries(found)
      .filter(([key, n]) => n > (ALLOWED[key]?.count ?? 0))
      .map(([key, n]) => `${key} ×${n}`);
    expect(over, 'a catch writes [] with no failed/error flag beside it — a failed read will render as "none"').toEqual([]);
  });

  it('every ALLOWED entry still exists at its pinned count (delete or lower the entry when you fix one)', () => {
    const stale = Object.entries(ALLOWED)
      .filter(([key, { count }]) => (found[key] ?? 0) !== count)
      .map(([key, { count }]) => `${key}: pinned ${count}, found ${found[key] ?? 0}`);
    expect(stale).toEqual([]);
  });
});
