/**
 * A chain parameter's `description` is USER-FACING COPY, not a code comment.
 *
 * The host renders it as the form field's help text — `RunInputsForm` passes it
 * straight to `TextField`/`CheckboxField` as `help`, which the shared primitive
 * wires up as `aria-describedby`. So it is not merely visible: a screen reader
 * reads it aloud as the field's description. A user filling in "Org id" heard:
 *
 *   "The org whose KB is searched (feature.kb.nodes.rag reads ctx.inputs.orgId —
 *    an exact match against the collection's org, so this MUST be set or the
 *    retrieval never resolves the collection)."
 *
 * Node type ids, `ctx.*` paths and pack names are implementation detail. They
 * belong in the chain's own `description`, in the node pack, or in an ADR.
 *
 * This ratchet also guards a SECOND failure mode that actually happened: the
 * copy was fixed once, and a parallel session's PR (#2716) — branched from an
 * older `origin/main` — silently restored the old strings while keeping the
 * version bump, leaving the repo and the published registry disagreeing AT THE
 * SAME VERSION. A version comparison cannot see that; a content check can.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const PACK_DIRS = ['examples/workflow-chain-packs', 'packs'];

/** Tokens that are implementation detail wherever they appear in user copy. */
const LEAKS: { pattern: RegExp; why: string }[] = [
  { pattern: /ctx\.(inputs|config|features)\b/, why: 'a runtime context path' },
  { pattern: /\b(feature|core|vendor)\.[a-z0-9-]+\.nodes\.[a-z0-9-]+/i, why: 'a node type id' },
  { pattern: /\bno upstream node\b/i, why: 'authoring rationale, not user guidance' },
];

interface Chain { chainId: string; parameters?: { properties?: Record<string, { description?: string }> } }

const PARAMS: { where: string; description: string }[] = [];
for (const dir of PACK_DIRS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const entry of readdirSync(abs)) {
    const file = join(abs, entry, 'pack.json');
    if (!existsSync(file)) continue;
    let parsed: { chains?: Chain[] };
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const ch of parsed.chains ?? []) {
      for (const [name, spec] of Object.entries(ch.parameters?.properties ?? {})) {
        if (typeof spec?.description === 'string') {
          PARAMS.push({ where: `${dir}/${entry} :: ${ch.chainId} :: ${name}`, description: spec.description });
        }
      }
    }
  }
}

describe('the scan reaches real parameter copy', () => {
  it('finds a substantial number of described chain parameters', () => {
    expect(PARAMS.length, 'no described parameters found — the ratchet is scanning nothing').toBeGreaterThan(100);
  });
});

describe('chain parameter help text is written for the person filling in the form', () => {
  it.each(LEAKS)('contains no $why', ({ pattern }) => {
    const offenders = PARAMS.filter((p) => pattern.test(p.description)).map((p) => `${p.where}: "${p.description.slice(0, 90)}…"`);
    expect(offenders, 'this string is read aloud as the field description — move the detail to the chain description or an ADR').toEqual([]);
  });
});
