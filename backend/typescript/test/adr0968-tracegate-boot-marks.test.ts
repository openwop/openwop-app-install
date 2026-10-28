/**
 * ADR 0968 P2 — `createApp` marks app boot for Tracegate's shadow measurement, and
 * the marks change nothing about the app.
 *
 * WHY THIS EXISTS. The marks are product code on the boot path of every deploy.
 * They are justified only if they are inert: with no recorder installed
 * (production), `globalThis.__tracegateBoot` is undefined and each mark is one
 * short-circuiting property read. This file pins both halves: the marks fire
 * exactly once each, in order, with the returned app; and the app built with a
 * hook installed has the same route table as the one built without.
 *
 * Under a recording gate the recorder owns `__tracegateBoot`; this file swaps in
 * its own stub and restores the recorder's afterwards, so this one file's boot
 * split is simply not recorded (its whole run counts as test phase: safe).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

type Hook = (phase: string, app?: unknown) => void;
const g = globalThis as { __tracegateBoot?: Hook };
const saved = g.__tracegateBoot;
afterEach(() => { g.__tracegateBoot = saved; });

const config = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };
interface Layer { name?: string; route?: { path: unknown; methods: Record<string, boolean> } }
const table = (app: unknown): string[] =>
  ((app as { _router?: { stack?: Layer[] } })._router?.stack ?? [])
    .map((l) => (l.route ? `${Object.keys(l.route.methods).sort().join(',')} ${String(l.route.path)}` : `use ${l.name}`));

describe('ADR 0968 P2 — createApp boot marks', () => {
  it('marks start, then end with the returned app, exactly once each', async () => {
    const calls: Array<[string, unknown]> = [];
    g.__tracegateBoot = (phase, app) => { calls.push([phase, app]); };
    const app = await createApp(config);
    expect(calls.map(([p]) => p)).toEqual(['start', 'end']);
    expect(calls[0][1]).toBeUndefined();
    expect(calls[1][1]).toBe(app);
  }, 120_000);

  it('boots normally when the hook throws (a recorder bug never fails a boot)', async () => {
    let calls = 0;
    g.__tracegateBoot = () => { calls++; throw new Error('recorder bug'); };
    const app = await createApp(config);
    expect(calls).toBe(2);
    expect(table(app).length).toBeGreaterThan(100);
  }, 120_000);

  it('builds the same route table with no hook installed as with one', async () => {
    g.__tracegateBoot = undefined;
    const bare = table(await createApp(config));
    g.__tracegateBoot = () => {};
    const hooked = table(await createApp(config));
    expect(bare.length).toBeGreaterThan(100);
    expect(hooked).toEqual(bare);
  }, 240_000);
});
