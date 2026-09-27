/**
 * `core.openwop.integration.email-send` fails SILENTLY when its envelope is
 * unwired: `ctx.email.send` degrades an unconfigured provider to
 * `{sent:false, error:'email_not_connected'}` (`host/emailAdapter.ts`) without
 * throwing or echoing the attempted recipient back into the node's outputs. So
 * a chain that sends to `to: undefined` and a chain that is merely
 * unconfigured are INDISTINGUISHABLE at run time — which is how three shipped
 * `campaign-journeys` nodes kept a missing recipient through several reviews.
 *
 * Run-time can't see it, so this checks it structurally, for every email-send
 * node in every chain pack:
 *
 *   - `to` is populated (an edge onto the `to` port, or a declared input);
 *   - `subject` likewise;
 *   - a body is present under a key the impl actually reads — it destructures
 *     `{ to, cc, bcc, subject, text, html }`, so `body` is silently dropped;
 *   - no declared input is outside `email-send.input.json` (which is
 *     `additionalProperties:false`) — `from` is a CONFIG field, and declaring
 *     it as an input reads like it works.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const PACK_DIRS = ['examples/workflow-chain-packs', 'packs'];
const TYPE_ID = 'core.openwop.integration.email-send';

/** The impl's destructure in `packs/core.openwop.integration/index.mjs`. */
const ALLOWED_INPUTS = new Set(['to', 'cc', 'bcc', 'subject', 'text', 'html']);
const BODY_KEYS = ['text', 'html'];

interface Node { id: string; typeId?: string; inputs?: Record<string, unknown> }
interface Edge { from: string; to: string }
interface Chain { chainId: string; dag?: { nodes?: Node[]; edges?: Edge[] } }

function nodeOf(ref: string): string {
  const dot = ref.indexOf('.');
  return dot === -1 ? ref : ref.slice(0, dot);
}
function portOf(to: string): string {
  const dot = to.indexOf('.');
  return dot === -1 ? 'input' : to.slice(dot + 1);
}

const SENDS: { where: string; node: Node; inboundPorts: string[] }[] = [];
for (const dir of PACK_DIRS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const entry of readdirSync(abs)) {
    const file = join(abs, entry, 'pack.json');
    if (!existsSync(file)) continue;
    let parsed: { chains?: Chain[] };
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const ch of parsed.chains ?? []) {
      for (const n of ch.dag?.nodes ?? []) {
        if (n.typeId !== TYPE_ID) continue;
        SENDS.push({
          where: `${dir}/${entry} :: ${ch.chainId} :: ${n.id}`,
          node: n,
          inboundPorts: (ch.dag?.edges ?? []).filter((e) => nodeOf(e.to) === n.id).map((e) => portOf(e.to)),
        });
      }
    }
  }
}

/** A port counts as populated by an inbound edge OR a declared node input. */
function populated(s: { node: Node; inboundPorts: string[] }, port: string): boolean {
  return s.inboundPorts.includes(port) || port in (s.node.inputs ?? {});
}

describe('the scan reaches real email-send nodes (a vacuous scan passes forever)', () => {
  it('finds at least one', () => {
    expect(SENDS.length, 'no email-send nodes found — the ratchet is scanning nothing').toBeGreaterThan(0);
  });
});

describe('every shipped email-send node has a complete envelope', () => {
  it('a recipient is wired — otherwise the send silently goes nowhere', () => {
    const missing = SENDS.filter((s) => !populated(s, 'to')).map((s) => `${s.where} (inbound ports: ${s.inboundPorts.join(', ') || 'none'})`);
    expect(missing, '`to` is required by email-send.input.json and nothing populates it').toEqual([]);
  });

  it('a subject is wired', () => {
    expect(SENDS.filter((s) => !populated(s, 'subject')).map((s) => s.where)).toEqual([]);
  });

  it('a body is wired under a key the impl reads (`text`/`html`, never `body`)', () => {
    const bad = SENDS.filter((s) => !BODY_KEYS.some((k) => populated(s, k))).map((s) => s.where);
    expect(bad, 'the impl destructures text/html — a `body` input is silently dropped').toEqual([]);
  });

  it('declares no input outside the closed input schema', () => {
    const stray = SENDS.flatMap((s) =>
      Object.keys(s.node.inputs ?? {}).filter((k) => !ALLOWED_INPUTS.has(k)).map((k) => `${s.where}: "${k}"`));
    expect(stray, 'email-send.input.json is additionalProperties:false — `from` is CONFIG, not an input').toEqual([]);
  });
});
