#!/usr/bin/env node
/**
 * release-bus.mjs — the cross-machine release bus (ADR 0991).
 *
 * A GCS bucket every machine and cloud session can read, so a gate or a
 * deploy on one machine is visible to the others. ADVISORY, with ONE bounded
 * exception: `acquire` makes a release wait for a live release on the SAME
 * target (user decision 2026-10-27, D9 below). Nothing else may block, refuse
 * or slow a release (AGENTS.md, #4762). Every command:
 *   - finishes within OPENWOP_RELEASE_BUS_TIMEOUT_MS (default 10 s) overall
 *     (`acquire`: each poll does; its wait is bounded by OPENWOP_DEPLOY_QUEUE_MAX_MIN);
 *   - exits 0, whatever happened: no gcloud, no auth, offline, a hung call or
 *     a bad bucket all print `release-bus: unavailable (…)` and return;
 *   - is a no-op with OPENWOP_RELEASE_BUS=off.
 *
 *   publish '<event-json>'      write events/<ts>-<host>-<rand>.json, create-only
 *   claim --id I --kind gate|deploy|certify [--targets a,b] [--prs 1,2] [--base sha] [--tree sha]
 *         [--expected-min N] [--ttl-min N]       add or replace an `active` entry
 *   acquire --id I --kind deploy|certify --targets a,b [--max-wait-min N] [claim options]
 *                                                claim, but first queue behind any live
 *                                                lease on the SAME target (see TARGETS)
 *   release --id I                               remove an `active` entry
 *   set-production --commit sha --revision rev [--target t]   record what serves
 *   status [--minutes N]                         productions, active entries, recent events
 *   warn-others [--kinds gate,deploy] [--targets a,b]
 *                                                a WARN line per live lease held by ANOTHER host
 *   note --to <name|*> --re <PR-or-slot> [--from <name>] [--] <text…>   post a note to another session
 *   notes [--for <name>] [--minutes N]           read notes (all, or those to <name> or to everyone)
 *
 * NOTES (user rule 2026-10-27): any session on any machine may post to and read
 * from any other through the bus. A note is an event (`kind: "note"`, `from`,
 * `to`, `re`, `text`); it asks or tells, it never approves (approval comes only
 * from the user in the session that acts) and it never holds anything. It must
 * not carry secrets, DSNs or PII: a note whose text looks like a credential or a
 * connection string is NOT sent, and the refusal says why.
 *
 * `queue.json` is read pinned to its generation (`queue.json#<gen>`) and written
 * with `--if-generation-match=<gen>`; a 412 (someone wrote in between) re-reads
 * and retries until the deadline. An entry whose `leaseUntil` has passed reads
 * as STALE, never as held: a crashed train must not look like a live one.
 *
 * TARGETS (user decision 2026-10-27, ADR 0991 D9): each server a release
 * touches is a target, derived from deploy.env by release-bus.sh, never typed:
 * `run:<project>/<region>/<service>` and `hosting:<firebase-project>/<target>`.
 * Two deploys COLLIDE only when they share a target, and only then does the
 * later one wait (`acquire`). This is the ONE place the bus waits, and it is
 * bounded and fail-open: OPENWOP_DEPLOY_QUEUE_MAX_MIN (default 60) and it
 * proceeds with a WARN; an unavailable bus proceeds; a STALE lease never
 * blocks; OPENWOP_DEPLOY_QUEUE=off skips the wait. Gates carry no target and
 * never wait. A waiter keeps a `waiting` entry with a fixed `queuedAt` and a
 * short lease it renews each poll, and the step from waiting to `running` is
 * decided inside the generation-matched write, so two simultaneous acquirers
 * cannot both go first and the queue is FIFO.
 *
 * No dependencies: it shells to `gcloud storage`, which every deploying machine has.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const BUCKET = process.env.OPENWOP_RELEASE_BUS_BUCKET || 'openwop-dev-release-queue';
const TIMEOUT_MS = Number(process.env.OPENWOP_RELEASE_BUS_TIMEOUT_MS) || 10_000;
/** Each bus command (and each poll of an `acquire` wait) gets TIMEOUT_MS; the wait itself does not. */
let deadline = Date.now() + TIMEOUT_MS;
const resetDeadline = () => { deadline = Date.now() + TIMEOUT_MS; };
const HOST = (process.env.OPENWOP_RELEASE_BUS_HOST || hostname()).split('.')[0];
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || undefined;
/** Typical durations (minutes); the lease is about twice that. */
const TYPICAL_MIN = { gate: 45, deploy: 16, certify: 10 };

class Unavailable extends Error {}
/** queue.json kept changing under us until the deadline: contended, not down. */
class Contended extends Unavailable {}

const sleepMs = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const list = (v) => (v === undefined || v === 'true' ? [] : String(v).split(',').map((x) => x.trim()).filter(Boolean));
/** The app's own backend: what a pre-targets `production` key and a pre-targets deploy lease mean. */
const LEGACY_RUN_TARGET = process.env.OPENWOP_RELEASE_BUS_LEGACY_TARGET || 'run:openwop-dev/us-central1/openwop-app-backend';

function gcloud(args, { input } = {}) {
  const left = deadline - Date.now();
  if (left <= 0) throw new Unavailable('timed out');
  const r = spawnSync('gcloud', ['storage', ...args, '--quiet'], { encoding: 'utf8', timeout: left, input, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new Unavailable(r.error.code === 'ENOENT' ? 'no gcloud' : r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message);
  if (r.signal) throw new Unavailable('timed out');
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const isPrecondition = (err) => /\b412\b|precondition/i.test(err);
const firstLine = (s) => (s.trim().split('\n').find(Boolean) ?? 'error').slice(0, 160);

function withTemp(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'release-bus-'));
  try {
    const f = join(dir, 'body.json');
    writeFileSync(f, text);
    return fn(f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261026T193000Z
const base = () => ({ host: HOST, ...(SESSION ? { session: SESSION } : {}) });

// ── events ───────────────────────────────────────────────────────────────────
function publish(event) {
  const body = { ...base(), at: new Date().toISOString(), ...event };
  const name = `events/${stamp()}-${HOST}-${randomBytes(3).toString('hex')}.json`;
  const r = withTemp(`${JSON.stringify(body)}\n`, (f) => gcloud(['cp', f, `gs://${BUCKET}/${name}`, '--if-generation-match=0']));
  if (!r.ok) throw new Unavailable(firstLine(r.err));
  console.log(body.kind === 'note' ? `release-bus: note sent to ${body.to} [${body.re}]` : `release-bus: published ${body.kind ?? 'event'} ${body.phase ?? ''}`.trimEnd());
}

function recentEvents(minutes) {
  const now = Date.now();
  // One listing per hour prefix the window touches: the bucket keeps 90 days.
  const prefixes = new Set();
  for (let t = now - minutes * 60_000; t <= now + 3_600_000; t += 3_600_000) prefixes.add(stamp(new Date(t)).slice(0, 11)); // YYYYMMDDTHH
  const urls = [];
  for (const p of [...prefixes].sort()) {
    const r = gcloud(['ls', `gs://${BUCKET}/events/${p}*`]);
    if (r.ok) urls.push(...r.out.split('\n').filter((u) => u.startsWith('gs://')));
  }
  const cutoff = stamp(new Date(now - minutes * 60_000));
  const wanted = urls.filter((u) => u.slice(u.lastIndexOf('/') + 1) >= cutoff).sort().slice(-50);
  if (wanted.length === 0) return [];
  const r = gcloud(['cat', ...wanted]);
  if (!r.ok) throw new Unavailable(firstLine(r.err));
  return r.out.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

// ── queue.json (read, modify, write with a generation precondition) ─────────
function readQueue() {
  const d = gcloud(['objects', 'describe', `gs://${BUCKET}/queue.json`, '--format=value(generation)']);
  if (!d.ok) throw new Unavailable(firstLine(d.err));
  const gen = d.out.trim();
  const c = gcloud(['cat', `gs://${BUCKET}/queue.json#${gen}`]);
  if (!c.ok) return null; // replaced between the two calls: retry
  let q;
  try { q = JSON.parse(c.out); } catch { throw new Unavailable('queue.json is not JSON'); }
  if (!Array.isArray(q.active)) q.active = [];
  return { gen, q };
}

function updateQueue(mutate) {
  let saw412 = false;
  try {
    for (let attempt = 1; ; attempt += 1) {
      const cur = readQueue();
      if (cur) {
        const next = mutate(cur.q);
        next.updatedAt = new Date().toISOString();
        const w = withTemp(`${JSON.stringify(next)}\n`, (f) => gcloud(['cp', f, `gs://${BUCKET}/queue.json`, `--if-generation-match=${cur.gen}`]));
        if (w.ok) return attempt;
        if (!isPrecondition(w.err)) throw new Unavailable(firstLine(w.err));
        saw412 = true;
      }
      if (Date.now() >= deadline) throw new Contended('queue.json kept changing (412) until the deadline');
      sleepMs(Math.min(100 + Math.floor(Math.random() * 400), Math.max(0, deadline - Date.now()))); // jitter, so writers spread out
    }
  } catch (err) {
    // The deadline can run out inside the NEXT read rather than at the check
    // above. After a 412 that is still contention, not an unreachable bus.
    if (saw412 && err instanceof Unavailable && !(err instanceof Contended) && err.message === 'timed out') {
      throw new Contended('queue.json kept changing (412) until the deadline');
    }
    throw err;
  }
}

const isLive = (e, now = Date.now()) => typeof e.leaseUntil === 'string' && Date.parse(e.leaseUntil) > now;
// A long-dead entry is noise: drop those a day past their lease when we write.
const keep = (e) => !(typeof e.leaseUntil === 'string' && Date.parse(e.leaseUntil) < Date.now() - 86_400_000);

/** A pre-targets deploy or certify lease (an older checkout) is read as the app's own backend. */
const targetsOf = (e) => (Array.isArray(e.targets) ? e.targets : e.kind === 'deploy' || e.kind === 'certify' ? [LEGACY_RUN_TARGET] : []);
const sharedTarget = (a, b) => targetsOf(a).find((t) => targetsOf(b).includes(t));

function makeEntry(o, now = Date.now()) {
  const kind = o.kind ?? 'gate';
  const typical = Number(o['expected-min']) || TYPICAL_MIN[kind] || 30;
  const ttl = Number(o['ttl-min']) || typical * 2;
  const targets = list(o.targets);
  return {
    id: o.id, ...base(), kind, state: 'running',
    ...(targets.length ? { targets } : {}),
    ...(o.prs ? { prs: String(o.prs).split(',').filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p)) } : {}),
    ...(o.base ? { base: o.base } : {}), ...(o.tree ? { tree: o.tree } : {}), ...(o.commit ? { commit: o.commit } : {}),
    startedAt: new Date(now).toISOString(),
    expectedEndAt: new Date(now + typical * 60_000).toISOString(),
    leaseUntil: new Date(now + ttl * 60_000).toISOString(),
  };
}
const without = (q, id) => q.active.filter((e) => e.id !== id && keep(e));

function claim(o) {
  const entry = makeEntry(o);
  const tries = updateQueue((q) => ({ ...q, active: [...without(q, o.id), entry] }));
  console.log(`release-bus: claimed ${entry.kind} ${o.id}${entry.targets ? ` on ${entry.targets.join(',')}` : ''}${tries > 1 ? ` (after ${tries - 1} retr${tries > 2 ? 'ies' : 'y'})` : ''}`);
}

// ── acquire: the per-target deploy queue (ADR 0991 D9) ─────────────────────
/** (queuedAt, id) order; a lease written before queuedAt existed sorts by startedAt. */
const orderKey = (e) => `${e.queuedAt ?? e.startedAt ?? ''}\u0000${e.id ?? ''}`;
/** The live lease that must go before `me`, and the target they share. A RUNNING lease
 *  on a shared target always does; a WAITING one does only when it queued first. */
function blockerFor(q, me, exempt, now = Date.now()) {
  for (const e of q.active) {
    if (e.id === me.id || exempt.has(e.id) || !isLive(e, now)) continue;
    const t = sharedTarget(e, me);
    if (!t) continue;
    if (e.state !== 'waiting' || orderKey(e) < orderKey(me)) return { e, t };
  }
  return null;
}

function acquire(o) {
  if (list(o.targets).length === 0 || (process.env.OPENWOP_DEPLOY_QUEUE ?? '').toLowerCase() === 'off') { claim(o); return; }
  const maxMin = Number(o['max-wait-min'] ?? process.env.OPENWOP_DEPLOY_QUEUE_MAX_MIN ?? 60);
  const pollMs = Math.max(1, Number(process.env.OPENWOP_DEPLOY_QUEUE_POLL_S) || 30) * 1000;
  // A waiter renews once per poll; its lease outlives two missed polls, so a crashed
  // waiter holds nobody up for longer than that.
  const waitLeaseMs = Math.max(120_000, 3 * pollMs);
  // Exact ids only: deploy.sh exports its own id so the certify it runs does not queue behind it.
  const exempt = new Set(list(process.env.OPENWOP_RELEASE_BUS_PARENT));
  const t0 = Date.now();
  const queuedAt = new Date(t0).toISOString();
  const giveUpAt = t0 + (Number.isFinite(maxMin) ? maxMin : 60) * 60_000;
  let said = '';
  for (;;) {
    resetDeadline();
    let outcome = null;
    try {
      updateQueue((q) => {
        const now = Date.now();
        const me = { ...makeEntry(o, now), queuedAt };
        const b = blockerFor(q, me, exempt, now);
        if (b && now < giveUpAt) {
          outcome = { blocked: b };
          return { ...q, active: [...without(q, o.id), { ...me, state: 'waiting', leaseUntil: new Date(now + waitLeaseMs).toISOString() }] };
        }
        outcome = { go: true, forced: b };
        return { ...q, active: [...without(q, o.id), me] };
      });
    } catch (err) {
      if (err instanceof Contended && Date.now() < giveUpAt) {
        // Busy, not down: a 412 storm is other writers, so it is no reason to stop queueing.
        console.log('release-bus: queue.json is busy (412); still queued, retrying');
        sleepMs(Math.min(pollMs, giveUpAt - Date.now()));
        continue;
      }
      console.log(`release-bus: unavailable (${err instanceof Error ? err.message : String(err)}); proceeding without the queue`);
      return;
    }
    const waited = Math.round((Date.now() - t0) / 60_000);
    if (outcome.go) {
      if (outcome.forced) {
        console.log(`WARN release-bus: waited ${waited} min (max ${maxMin}) for ${fmtEntry(outcome.forced.e)} on ${outcome.forced.t}; PROCEEDING anyway. Two releases now share that target.`);
      }
      console.log(`release-bus: acquired ${o.kind ?? 'deploy'} ${o.id} on ${list(o.targets).join(',')}${said ? ` after ${waited} min` : ''}`);
      return;
    }
    const msg = `release-bus: queued behind ${fmtEntry(outcome.blocked.e)} on ${outcome.blocked.t}`;
    if (msg !== said) { console.log(msg); said = msg; }
    sleepMs(Math.min(pollMs, Math.max(0, giveUpAt - Date.now())));
  }
}

function release(o) {
  updateQueue((q) => ({ ...q, active: q.active.filter((e) => e.id !== o.id && keep(e)) }));
  console.log(`release-bus: released ${o.id}`);
}

function setProduction(o) {
  const target = o.target && o.target !== 'true' ? o.target : LEGACY_RUN_TARGET;
  const rec = { commit: o.commit, revision: o.revision, at: new Date().toISOString(), host: HOST };
  updateQueue((q) => ({
    ...q,
    productions: { ...(q.productions ?? {}), [target]: rec },
    // Older checkouts read only `production`: keep it for the app's own backend.
    ...(target === LEGACY_RUN_TARGET ? { production: rec } : {}),
  }));
  console.log(`release-bus: production ${target} = ${String(o.commit).slice(0, 9)} ${o.revision ?? ''}`.trimEnd());
}

// ── notes ──────────────────────────────────────────────────────────────────
const MAX_NOTE_CHARS = 2000;
/** Credential and connection-string shapes a note must never carry (not exhaustive: a guard, not a scanner). */
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bxox[abposr]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // scheme://user:password@host — a DSN
];
const noteFrom = (o) => `${o.from || process.env.NOTE_FROM || process.env.USER || 'session'}@${HOST}`;

function note(o, words) {
  const text = words.join(' ').trim();
  if (!o.to || !o.re || !text) { console.log('release-bus: note needs --to <name|*> --re <PR-or-slot> and a text'); return; }
  if (text.length > MAX_NOTE_CHARS) { console.log(`release-bus: note NOT sent — longer than ${MAX_NOTE_CHARS} characters; link the PR instead`); return; }
  if (SECRET_SHAPES.some((re) => re.test(text))) { console.log('release-bus: note NOT sent — it looks like it carries a credential or a connection string (no secrets, DSNs or PII on the bus)'); return; }
  publish({ kind: 'note', from: noteFrom(o), to: o.to, re: o.re, text });
}

/** A note is for <name> when it is to everyone, to <name> exactly, or to <name> without its @host. */
const noteFor = (n, name) => n.to === '*' || n.to === name || String(n.to).split('@')[0] === name.split('@')[0];
const fmtNote = (n) => `${n.at ?? '?'} ${n.from ?? n.host ?? '?'} -> ${n.to ?? '*'} [${n.re ?? ''}] ${String(n.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}`;

function notes(o) {
  const minutes = Number(o.minutes) || 120;
  const all = recentEvents(minutes).filter((e) => e.kind === 'note');
  const mine = o.for ? all.filter((n) => noteFor(n, o.for)) : all;
  console.log(`release-bus: ${mine.length} note(s), last ${minutes} min${o.for ? ` for ${o.for}` : ''}`);
  for (const n of mine) console.log(`  ${fmtNote(n)}`);
}

const fmtEntry = (e) => `${isLive(e) ? 'LIVE ' : 'STALE'} ${e.state === 'waiting' ? 'waiting ' : ''}${e.kind ?? '?'} ${e.host ?? '?'}${e.targets ? ` [${e.targets.join(',')}]` : ''}${e.prs ? ` #${e.prs.join(' #')}` : ''}${e.commit ? ` ${String(e.commit).slice(0, 9)}` : ''} since ${e.startedAt ?? '?'} (lease to ${e.leaseUntil ?? '?'})`;

function status(o) {
  const cur = readQueue();
  if (!cur) throw new Unavailable('queue.json changed while reading');
  const { q } = cur;
  console.log(`release-bus: gs://${BUCKET}  production ${q.production?.commit ? String(q.production.commit).slice(0, 9) : '?'} ${q.production?.revision ?? ''}`.trimEnd());
  const prods = { ...(q.productions ?? {}) };
  if (q.production?.commit && !prods[LEGACY_RUN_TARGET]) prods[LEGACY_RUN_TARGET] = q.production;
  const targets = new Set([...Object.keys(prods), ...q.active.flatMap(targetsOf)]);
  for (const t of [...targets].sort()) {
    const p = prods[t];
    const live = q.active.filter((e) => isLive(e) && targetsOf(e).includes(t));
    console.log(`  target ${t}: production ${p?.commit ? `${String(p.commit).slice(0, 9)} ${p.revision ?? ''}`.trimEnd() : '?'}; ${live.length ? `live: ${live.map((e) => `${e.state === 'waiting' ? 'waiting ' : ''}${e.kind} ${e.host}`).join(', ')}` : 'idle'}`);
  }
  if (q.active.length === 0) console.log('  active: none');
  for (const e of q.active) console.log(`  ${fmtEntry(e)}`);
  const minutes = Number(o.minutes) || 60;
  const evs = recentEvents(minutes);
  console.log(`  events, last ${minutes} min: ${evs.length}`);
  for (const e of evs) {
    if (e.kind === 'note') { console.log(`    note ${fmtNote(e)}`); continue; }
    console.log(`    ${e.at ?? '?'} ${e.host ?? '?'} ${e.kind ?? '?'} ${e.phase ?? ''}${e.prs ? ` #${[].concat(e.prs).join(' #')}` : ''}${e.result ? ` ${e.result}` : ''}`);
  }
}

function warnOthers(o) {
  const kinds = new Set(String(o.kinds ?? 'gate,deploy').split(','));
  const cur = readQueue();
  if (!cur) return;
  const mine = list(o.targets);
  const others = cur.q.active.filter((e) => e.host !== HOST && kinds.has(e.kind) && isLive(e));
  for (const e of others) {
    const theirs = targetsOf(e);
    // With --targets, a release on ANOTHER server is not ours to worry about (D9).
    if (mine.length && theirs.length && !theirs.some((t) => mine.includes(t))) {
      console.log(`INFO release-bus: another machine is releasing to a different target — ${fmtEntry(e)}.`);
      continue;
    }
    console.log(`WARN release-bus: another machine holds a live lease — ${fmtEntry(e)}. Advisory only; not waiting.`);
  }
}

function parseOpts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') break;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1);
    else o[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return o;
}

/** The words after the options: `note --to x --re 1 hello world` → ['hello', 'world'].
 *  Everything after a bare `--` is text, even if it starts with dashes. */
function positional(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { out.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) { if (!a.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i += 1; continue; }
    out.push(a);
  }
  return out;
}

function main() {
  if ((process.env.OPENWOP_RELEASE_BUS ?? '').toLowerCase() === 'off') return;
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseOpts(rest);
  try {
    switch (cmd) {
      case 'publish': {
        let ev;
        try { ev = JSON.parse(rest[0] ?? ''); } catch { console.log('release-bus: publish needs one JSON object'); return; }
        publish(ev); return;
      }
      case 'claim': if (!o.id) { console.log('release-bus: claim needs --id'); return; } claim(o); return;
      case 'acquire': if (!o.id) { console.log('release-bus: acquire needs --id'); return; } acquire(o); return;
      case 'release': if (!o.id) { console.log('release-bus: release needs --id'); return; } release(o); return;
      case 'set-production': if (!o.commit) { console.log('release-bus: set-production needs --commit'); return; } setProduction(o); return;
      case 'status': status(o); return;
      case 'warn-others': warnOthers(o); return;
      case 'note': note(o, positional(rest)); return;
      case 'notes': notes(o); return;
      default: console.log('usage: release-bus.mjs publish|claim|acquire|release|set-production|status|warn-others|note|notes'); return;
    }
  } catch (err) {
    console.log(`release-bus: unavailable (${err instanceof Error ? err.message : String(err)})`);
  }
}

main();
process.exitCode = 0;
