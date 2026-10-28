/**
 * ADR 0858 P4 — `a2a.refreshedAt` / `mcp.refreshedAt`, and the refresh SLA.
 *
 * `spec/v2/core/interop.md` §"The refresh SLA": "A host MUST re-evaluate its
 * advertised `versions[]` / `revisions[]` against the upstream registry within
 * the window its `refreshedAt` declares, and that window MUST NOT exceed 90
 * days. An advertisement older than its window is non-conformant."
 *
 * THIS FILE IS A DELIBERATE TIME BOMB. The staleness leg goes RED 90 days after
 * the review date in `host/a2aProfile.ts` / `host/mcpProfile.ts`. That is the
 * point, not a defect: the fix is to redo the review (compare the served set
 * against upstream), record it in the constant's docblock, and move the date.
 * Never move the date without the review — that is the lapse this exists to
 * stop.
 *
 * Under the clock-shift lane (`OPENWOP_CI_CLOCKSHIFT=1`, `test/setup/clockShift.ts`)
 * the clock is advanced on purpose, so a ratchet against `Date.now()` would red
 * that lane for a reason it does not hunt. There the leg proves the bomb is
 * ARMED instead — the shifted clock DOES read as stale — and checks the
 * real-clock age separately, so the lane neither reds nor goes vacuous.
 *
 * Tracker TST-BFA-2. Red when: either v2 record advertises a literal instead of
 * its constant; a constant is older than 90 days; a constant is not a real
 * calendar day.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { A2A_VERSIONS_REFRESHED_AT, _setV2ProjectA2aForTest } from '../src/host/a2aProfile.js';
import { MCP_VERSIONS_REFRESHED_AT } from '../src/host/mcpProfile.js';
import { v2A2aRecord, v2McpRecord } from '../src/routes/discovery.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DAY_MS = 86_400_000;
const SLA_DAYS = 90;
const CONSTANTS: ReadonlyArray<readonly [string, string, string]> = [
  ['a2a', A2A_VERSIONS_REFRESHED_AT, 'host/a2aProfile.ts A2A_VERSIONS_REFRESHED_AT'],
  ['mcp', MCP_VERSIONS_REFRESHED_AT, 'host/mcpProfile.ts MCP_VERSIONS_REFRESHED_AT'],
];

/** The `refreshedAt` property schema, read from the vendored capabilities schema. */
function refreshedAtValidator(family: string): (v: unknown) => boolean {
  const caps = JSON.parse(readFileSync(join(ROOT, 'schemas', 'v2', 'capabilities.schema.json'), 'utf8')) as {
    properties: Record<string, { properties: Record<string, unknown> }>;
  };
  const prop = caps.properties[family]?.properties['refreshedAt'];
  if (!prop) throw new Error(`capabilities.schema.json has no ${family}.refreshedAt — the shape check would be vacuous`);
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const fn = ajv.compile(prop as Record<string, unknown>);
  return (v) => fn(v) as boolean;
}

function ageDays(isoDate: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(`${isoDate}T00:00:00Z`)) / DAY_MS);
}

describe('ADR 0858 P4 — refreshedAt', () => {
  it.each(CONSTANTS)('%s: the constant is a calendar date the v2 schema accepts', (family, value) => {
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A real calendar day, not merely the right shape (2026-02-30 matches the regex).
    expect(new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10)).toBe(value);
    expect(refreshedAtValidator(family)(value)).toBe(true);
    expect(refreshedAtValidator(family)('2026-10-07T00:00:00Z'), 'the validator must be able to fail').toBe(false);
  });

  it('the records advertise the constants, not a copy', () => {
    const saved = { r: process.env.OPENWOP_V1_RETIRED, a: process.env.OPENWOP_A2A_SERVER_ENABLED };
    process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
    _setV2ProjectA2aForTest(true);
    try {
      expect(v2A2aRecord('2.0', '2.1')?.['refreshedAt']).toBe(A2A_VERSIONS_REFRESHED_AT);
      expect(v2McpRecord('2.0', '2.1')['refreshedAt']).toBe(MCP_VERSIONS_REFRESHED_AT);
    } finally {
      _setV2ProjectA2aForTest(undefined);
      if (saved.r === undefined) delete process.env.OPENWOP_V1_RETIRED; else process.env.OPENWOP_V1_RETIRED = saved.r;
      if (saved.a === undefined) delete process.env.OPENWOP_A2A_SERVER_ENABLED; else process.env.OPENWOP_A2A_SERVER_ENABLED = saved.a;
    }
  });

  it.each(CONSTANTS)('%s: the review is younger than the 90-day SLA (DELIBERATE TIME BOMB — see the docblock)', (_family, value, where) => {
    const shiftDays = process.env.OPENWOP_CI_CLOCKSHIFT === '1' ? Number(process.env.OPENWOP_CLOCKSHIFT_DAYS ?? '365') : 0;
    const realNow = Date.now() - shiftDays * DAY_MS;
    const age = ageDays(value, realNow);
    expect(age, `${where} is ${age} days old — interop.md caps the window at ${SLA_DAYS}. Re-evaluate the served versions against upstream, record the review in the constant's docblock, then move the date. Do not move the date alone.`).toBeLessThanOrEqual(SLA_DAYS);
    expect(age, `${where} is in the future`).toBeGreaterThanOrEqual(0);
    if (shiftDays > SLA_DAYS) {
      // The clock-shift lane: the bomb must be armed, not defused.
      expect(ageDays(value, Date.now())).toBeGreaterThan(SLA_DAYS);
    }
  });
});
