/**
 * XCH-RC-2 — the Replan Composer's prompt restates the lane shapes in prose
 * beside the generated contract. This pins the prose to the SSoT
 * (`schemas/plan-revision.schema.json`): every lane the schema allows is named
 * and no other; each lane's required fields appear in the prompt; the daypart
 * values and the command-count bound match. A schema edit the prose does not
 * follow (or the reverse) turns this red. Sabotage: adding a lane to the schema,
 * or changing `maxItems`, reds it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACK = join(import.meta.dirname, '..', '..', '..', 'packs/vendor.openwop-app.kicktodo.agents');
const prompt = readFileSync(join(PACK, 'prompts/replan-composer.md'), 'utf8');
type Lane = { required: string[]; properties: Record<string, { const?: string; enum?: unknown[] }> };
const schema = JSON.parse(readFileSync(join(PACK, 'schemas/plan-revision.schema.json'), 'utf8')) as {
  properties: { commands: { maxItems: number; items: { oneOf: Lane[] } } };
};
const lanes = schema.properties.commands.items.oneOf;
const laneName = (l: Lane): string => String(l.properties.lane?.const);

describe('replan-composer prompt ↔ plan-revision schema (XCH-RC-2)', () => {
  it('names exactly the schema\'s lanes, as bold list items', () => {
    const named = [...prompt.matchAll(/^- \*\*([a-z]+)\*\* —/gm)].map((m) => m[1]).sort();
    expect(named).toEqual(lanes.map(laneName).sort());
  });

  it('every lane\'s required fields are named in the prompt', () => {
    for (const l of lanes) {
      for (const f of l.required.filter((k) => k !== 'lane')) {
        expect(prompt.includes(`\`${f}\``) || prompt.includes(`\`${f}:`), `${laneName(l)} needs \`${f}\` in the prompt`).toBe(true);
      }
    }
  });

  it('the daypart values and the command-count bound match the schema', () => {
    const schedule = lanes.find((l) => laneName(l) === 'schedule')!;
    for (const v of (schedule.properties.daypart?.enum ?? []).filter((x) => x !== null)) expect(prompt).toContain(`\`${String(v)}\``);
    expect(prompt).toContain('`daypart: null`');
    expect(prompt).toContain(`0–${schema.properties.commands.maxItems} lane commands`);
  });
});
