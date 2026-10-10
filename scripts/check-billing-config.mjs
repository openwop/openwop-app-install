#!/usr/bin/env node
/**
 * ADR 0820 §6 — check an operator's billing env against `distributions/bundles.json`.
 *
 * ADR 0419 DATA-419-2 named the hazard and left it to "the deploy checklist":
 * once `OPENWOP_BILLING_PLAN_FEATURES` narrows a plan, a bundle feature that is
 * neither in the plan nor in a PRICED bundle is a permanent 403 with no purchase
 * path. MEASURED 2026-10-05 on app.openwop.dev: `job-search` was exactly that
 * (gated, unpriced, absent from `free`) for every non-operator tenant. A checklist
 * line did not catch it; this script does.
 *
 * Read-only. Reads the three env values from the process env, or from a Cloud Run
 * service with `--cloud-run <service> --region <r> --project <p>` (gcloud describe).
 *
 *   node scripts/check-billing-config.mjs
 *   node scripts/check-billing-config.mjs --cloud-run openwop-app-backend --region us-central1 --project openwop-dev
 *
 * Exit 1 on an ERROR (in any narrowed plan, a locked-and-unbuyable feature; a price
 * naming no bundle). WARNs (a priced feature also given free, a priced bundle with no
 * display copy, a plan holding part of a bundle, a plan id in no bundle — a typo or
 * noise) print but do not fail.
 *
 * ADR 0820 §5 / §7 (P3 + P5) — also:
 *  - plan entries `"bundle:<id>"` are EXPANDED before every check (an unknown bundle is
 *    an ERROR: the host ignores it, so the plan silently lacks what was meant);
 *  - `OPENWOP_BILLING_STANDALONE_BUNDLES` (array of real bundle ids; ERROR otherwise):
 *    a plan listing a standalone bundle's feature, literally or by `bundle:`, is an
 *    ERROR (the host strips it), and a `'*'` plan is checked as "everything but the
 *    standalone bundles", so an unpriced standalone bundle is a locked-and-unbuyable ERROR;
 *  - `OPENWOP_BILLING_TRIAL_DAYS` (`{"plan:<tier>"|"bundle:<id>": 1..730}`),
 *    `OPENWOP_BILLING_PAST_DUE_GRACE_DAYS` (a whole number ≥ 0), and
 *    `OPENWOP_BILLING_{BUNDLE,PLAN}_PRICE_CADENCE` (`{"<priceId>":"month"|"year"}`, each
 *    key a price of that catalog) are shape-checked; a bad shape or a name that is not
 *    a real plan / bundle / price is an ERROR.
 *
 * ADR 0821 D7 — `OPENWOP_BILLING_TOKEN_PACK_PRICES` (`{"<priceId>": tokens > 0}`) and its
 * optional display copy `OPENWOP_BILLING_TOKEN_PACK_DISPLAY`
 * (`{"<priceId>":{"price":"$5","label":"Starter"}}`): a display key that is not a configured
 * pack price, or an entry that is not an object of string `price`/`label`, is an ERROR (the
 * host ignores it). A pack with no display `price` WARNs: the store lists its credits but
 * offers no buy button.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = [
  'OPENWOP_BILLING_PLAN_FEATURES', 'OPENWOP_BILLING_BUNDLE_PRICES', 'OPENWOP_BILLING_BUNDLE_DISPLAY',
  'OPENWOP_BILLING_PLAN_PRICES', 'OPENWOP_BILLING_STANDALONE_BUNDLES', 'OPENWOP_BILLING_TRIAL_DAYS',
  'OPENWOP_BILLING_PAST_DUE_GRACE_DAYS', 'OPENWOP_BILLING_BUNDLE_PRICE_CADENCE', 'OPENWOP_BILLING_PLAN_PRICE_CADENCE',
  'OPENWOP_BILLING_BUNDLE_ONETIME', 'OPENWOP_BILLING_TOKEN_PACK_PRICES', 'OPENWOP_BILLING_TOKEN_PACK_DISPLAY',
];
const PLAN_TIERS = ['free', 'pro', 'team', 'enterprise'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function readEnv() {
  const service = arg('--cloud-run');
  if (!service) return Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const args = ['run', 'services', 'describe', service, '--format=json'];
  for (const f of ['--region', '--project']) if (arg(f)) args.push(f, arg(f));
  const svc = JSON.parse(execFileSync('gcloud', args, { encoding: 'utf8' }));
  const env = svc.spec.template.spec.containers[0].env ?? [];
  return Object.fromEntries(KEYS.map((k) => [k, env.find((e) => e.name === k)?.value]));
}

function parse(name, raw) {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { throw new Error(`${name} is not valid JSON`); }
}

const env = readEnv();
const plans = parse(KEYS[0], env[KEYS[0]]);
const prices = parse(KEYS[1], env[KEYS[1]]) ?? {};
const display = parse(KEYS[2], env[KEYS[2]]) ?? {};
const planPrices = parse('OPENWOP_BILLING_PLAN_PRICES', env.OPENWOP_BILLING_PLAN_PRICES) ?? {};
const standaloneRaw = parse('OPENWOP_BILLING_STANDALONE_BUNDLES', env.OPENWOP_BILLING_STANDALONE_BUNDLES);
const trialDays = parse('OPENWOP_BILLING_TRIAL_DAYS', env.OPENWOP_BILLING_TRIAL_DAYS);
const bundleCadence = parse('OPENWOP_BILLING_BUNDLE_PRICE_CADENCE', env.OPENWOP_BILLING_BUNDLE_PRICE_CADENCE);
const planCadence = parse('OPENWOP_BILLING_PLAN_PRICE_CADENCE', env.OPENWOP_BILLING_PLAN_PRICE_CADENCE);
const tokenPacks = parse('OPENWOP_BILLING_TOKEN_PACK_PRICES', env.OPENWOP_BILLING_TOKEN_PACK_PRICES);
const tokenPackDisplay = parse('OPENWOP_BILLING_TOKEN_PACK_DISPLAY', env.OPENWOP_BILLING_TOKEN_PACK_DISPLAY);
const oneTime = parse('OPENWOP_BILLING_BUNDLE_ONETIME', env.OPENWOP_BILLING_BUNDLE_ONETIME) ?? [];
const catalog = JSON.parse(readFileSync(join(ROOT, 'distributions', 'bundles.json'), 'utf8'));
const bundles = catalog.bundles ?? {};

const errors = [];
const warns = [];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const priced = new Set();
for (const [priceId, bundleId] of Object.entries(prices)) {
  if (!bundles[bundleId]) errors.push(`price ${priceId} names '${bundleId}', which is not a bundle (it can never be sold)`);
  else priced.add(bundleId);
}
for (const b of priced) if (!display[b]) warns.push(`priced bundle '${b}' has no OPENWOP_BILLING_BUNDLE_DISPLAY entry (the store shows no price)`);

// ── ADR 0820 §5 — standalone bundles ──
const standalone = new Set();
if (standaloneRaw !== undefined) {
  if (!Array.isArray(standaloneRaw)) errors.push('OPENWOP_BILLING_STANDALONE_BUNDLES must be a JSON array of bundle ids');
  else for (const b of standaloneRaw) {
    if (typeof b === 'string' && bundles[b]) standalone.add(b);
    else errors.push(`OPENWOP_BILLING_STANDALONE_BUNDLES names '${b}', which is not a bundle (the host ignores it)`);
  }
}
const standaloneFeatures = new Set([...standalone].flatMap((b) => bundles[b].features));

// Every NARROWED plan (an explicit string array) is checked, not only `free`. A plan's
// list is a second copy of bundle composition, so it drifts whenever bundles.json moves
// (ADR 0820 architect finding #3). `'*'` / absent = unrestricted for that plan.
const bundleOf = new Map();
for (const [b, def] of Object.entries(bundles)) for (const f of def.features) bundleOf.set(f, b);
if (plans !== undefined && !isObj(plans)) errors.push('OPENWOP_BILLING_PLAN_FEATURES must be a JSON object keyed by plan tier');
const effective = [];
for (const plan of PLAN_TIERS) {
  const list = isObj(plans) ? plans[plan] : undefined;
  if (Array.isArray(list)) {
    // ADR 0820 §5 — expand `bundle:<id>` exactly as the host does, then strip standalone.
    const expanded = new Set();
    for (const entry of list) {
      if (typeof entry !== 'string') { errors.push(`plan '${plan}' has a non-string entry — the host treats the WHOLE plan as unrestricted`); continue; }
      if (!entry.startsWith('bundle:')) {
        if (!bundleOf.has(entry)) warns.push(`plan '${plan}' lists '${entry}', which is in no bundle — no effect (typo?)`);
        expanded.add(entry);
        continue;
      }
      const b = entry.slice('bundle:'.length);
      if (!bundles[b]) { errors.push(`plan '${plan}' references '${entry}', which is not a bundle — the host ignores it, so the plan lacks it`); continue; }
      for (const f of bundles[b].features) expanded.add(f);
    }
    for (const f of expanded) {
      if (standaloneFeatures.has(f)) errors.push(`plan '${plan}' lists '${f}' of standalone bundle '${bundleOf.get(f)}' — standalone bundles are never in a plan (the host strips it)`);
    }
    effective.push([plan, new Set([...expanded].filter((f) => !standaloneFeatures.has(f)))]);
  } else if (isObj(plans) && standalone.size > 0) {
    // '*' while plans are configured: the host grants everything BUT the standalone bundles.
    effective.push([plan, new Set([...bundleOf.keys()].filter((f) => !standaloneFeatures.has(f)))]);
  }
}
if (effective.length === 0) {
  console.log('no plan is narrowed (absent or "*") — every feature is unrestricted; nothing can be locked.');
}
for (const [plan, has] of effective) {
  for (const [b, def] of Object.entries(bundles)) {
    const included = def.features.filter((f) => has.has(f));
    for (const f of def.features) {
      if (!has.has(f) && !priced.has(b)) errors.push(`plan '${plan}': '${f}' (bundle '${b}') is locked and has no price — no way to get it`);
      if (has.has(f) && priced.has(b) && plan === 'free') warns.push(`'${f}' is in priced bundle '${b}' AND in the free plan — the price buys nothing for it`);
    }
    if (included.length > 0 && included.length < def.features.length) {
      warns.push(`plan '${plan}' includes ${included.length}/${def.features.length} of bundle '${b}' (missing: ${def.features.filter((f) => !has.has(f)).join(', ')}) — partial bundle (use "bundle:${b}")`);
    }
  }
}

// ── ADR 0820 §7 — trials, past-due grace, cadence ──
const pricedPlans = new Set(Object.values(planPrices));
if (trialDays !== undefined) {
  if (!isObj(trialDays)) errors.push('OPENWOP_BILLING_TRIAL_DAYS must be a JSON object {"plan:<tier>"|"bundle:<id>": days}');
  else for (const [key, days] of Object.entries(trialDays)) {
    if (!Number.isInteger(days) || days < 1 || days > 730) errors.push(`OPENWOP_BILLING_TRIAL_DAYS['${key}'] must be a whole number of days, 1–730 (the host ignores it)`);
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'plan') {
      if (!PLAN_TIERS.includes(id) || id === 'free') errors.push(`OPENWOP_BILLING_TRIAL_DAYS key '${key}' names no paid plan tier (pro, team, enterprise)`);
      else if (!pricedPlans.has(id)) warns.push(`OPENWOP_BILLING_TRIAL_DAYS key '${key}': plan '${id}' has no price in OPENWOP_BILLING_PLAN_PRICES — the trial is never offered`);
    } else if (kind === 'bundle') {
      if (!bundles[id]) errors.push(`OPENWOP_BILLING_TRIAL_DAYS key '${key}' names no bundle`);
      else if (!priced.has(id)) warns.push(`OPENWOP_BILLING_TRIAL_DAYS key '${key}': bundle '${id}' is not priced — the trial is never offered`);
      else if (Array.isArray(oneTime) && oneTime.includes(id)) warns.push(`OPENWOP_BILLING_TRIAL_DAYS key '${key}': bundle '${id}' is a one-time unlock — one-time purchases never trial`);
    } else {
      errors.push(`OPENWOP_BILLING_TRIAL_DAYS key '${key}' must start with "plan:" or "bundle:"`);
    }
  }
}
const grace = env.OPENWOP_BILLING_PAST_DUE_GRACE_DAYS;
if (grace !== undefined && grace !== '' && !/^\d+$/.test(String(grace))) {
  errors.push(`OPENWOP_BILLING_PAST_DUE_GRACE_DAYS must be a whole number of days ≥ 0 (got '${grace}'; the host treats it as 0)`);
}
function checkCadence(name, map, catalogPrices) {
  if (map === undefined) return;
  if (!isObj(map)) { errors.push(`${name} must be a JSON object {"<priceId>":"month"|"year"}`); return; }
  for (const [priceId, cadence] of Object.entries(map)) {
    if (cadence !== 'month' && cadence !== 'year') errors.push(`${name}['${priceId}'] must be "month" or "year" (got '${cadence}')`);
    if (!(priceId in catalogPrices)) errors.push(`${name} names price '${priceId}', which is not in its price catalog`);
  }
}
checkCadence('OPENWOP_BILLING_BUNDLE_PRICE_CADENCE', bundleCadence, prices);
checkCadence('OPENWOP_BILLING_PLAN_PRICE_CADENCE', planCadence, planPrices);
// Two prices of ONE cadence for the same bundle/plan: checkout sells the first only.
function checkAmbiguous(label, catalogPrices, cadenceMapValue) {
  const seen = new Map();
  for (const [priceId, target] of Object.entries(catalogPrices)) {
    const cadence = (isObj(cadenceMapValue) && cadenceMapValue[priceId]) || 'month';
    const k = `${target}/${cadence}`;
    if (seen.has(k)) warns.push(`${label} '${target}' has two ${cadence}ly prices (${seen.get(k)}, ${priceId}) — checkout sells only the first; mark one "year" in the cadence map?`);
    else seen.set(k, priceId);
  }
}
checkAmbiguous('bundle', prices, bundleCadence);
checkAmbiguous('plan', planPrices, planCadence);

// ── ADR 0821 D7 — AI-credit packs + their store display copy ──
const packPrices = {};
if (tokenPacks !== undefined) {
  if (!isObj(tokenPacks)) errors.push('OPENWOP_BILLING_TOKEN_PACK_PRICES must be a JSON object {"<priceId>": tokens}');
  else for (const [priceId, tokens] of Object.entries(tokenPacks)) {
    if (typeof tokens === 'number' && tokens > 0) packPrices[priceId] = tokens;
    else errors.push(`OPENWOP_BILLING_TOKEN_PACK_PRICES['${priceId}'] must be a positive number of tokens (the host ignores it)`);
  }
}
const packDisplayed = new Set();
if (tokenPackDisplay !== undefined) {
  if (!isObj(tokenPackDisplay)) errors.push('OPENWOP_BILLING_TOKEN_PACK_DISPLAY must be a JSON object {"<priceId>":{"price":"$5","label":"…"}}');
  else for (const [priceId, d] of Object.entries(tokenPackDisplay)) {
    if (!(priceId in packPrices)) errors.push(`OPENWOP_BILLING_TOKEN_PACK_DISPLAY names price '${priceId}', which is not in OPENWOP_BILLING_TOKEN_PACK_PRICES (the host ignores it)`);
    if (!isObj(d)) { errors.push(`OPENWOP_BILLING_TOKEN_PACK_DISPLAY['${priceId}'] must be an object {"price":"$5","label":"…"}`); continue; }
    for (const f of ['price', 'label']) {
      if (d[f] !== undefined && typeof d[f] !== 'string') errors.push(`OPENWOP_BILLING_TOKEN_PACK_DISPLAY['${priceId}'].${f} must be a string (the host ignores it)`);
    }
    if (typeof d.price === 'string' && d.price.trim()) packDisplayed.add(priceId);
  }
}
for (const priceId of Object.keys(packPrices)) {
  if (!packDisplayed.has(priceId)) warns.push(`token pack '${priceId}' has no OPENWOP_BILLING_TOKEN_PACK_DISPLAY price (the store lists its credits with no buy button)`);
}

for (const w of warns) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`${priced.size} priced bundle(s): ${[...priced].join(', ') || 'none'}; standalone: ${[...standalone].join(', ') || 'none'}; ${Object.keys(packPrices).length} credit pack(s), ${packDisplayed.size} with a display price; ${errors.length} error(s), ${warns.length} warning(s).`);
process.exit(errors.length ? 1 : 0);
