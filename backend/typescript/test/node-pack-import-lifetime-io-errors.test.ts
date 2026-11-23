/**
 * ADR 1152 follow-up (#6156): an I/O failure in the import-lifetime guard is
 * reported as itself, not as `pack_restart_required`.
 *
 * Why: the guard used to wrap every step in a bare `catch {}` and rethrow
 * PackRestartRequiredError, so a missing or unreadable pack.json told the
 * operator to restart the host. A restart cannot fix that. It now propagates
 * the real error. That still refuses the load or install (fail closed), the
 * install lane maps it to a 502 rather than a 409, and nothing is bound.
 *
 * Sabotage witness: put the `try { … } catch { throw new
 * PackRestartRequiredError(); }` back around claimNodePackImport's body and
 * the first case goes red (the rejection is a PackRestartRequiredError).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assertNodePackReplaceable,
  claimNodePackImport,
  PackRestartRequiredError,
} from '../src/packs/nodePackImportLifetime.js';
import { translateInstallError } from '../src/packs/installLane.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function packDir(withManifest: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'owp-lifetime-io-'));
  roots.push(root);
  const dir = join(root, 'pack');
  mkdirSync(dir);
  if (withManifest) writeFileSync(join(dir, 'pack.json'), '{"name":"fixture.lifetime-io","version":"1.0.0"}\n');
  return dir;
}

it('a missing pack.json rejects the claim with ENOENT, binds nothing, and maps to 502 not 409', () => {
  const dir = packDir(false);
  let thrown: unknown;
  try { claimNodePackImport(dir, Buffer.from('{}')); } catch (err) { thrown = err; }
  expect(thrown, 'the claim must refuse').toBeInstanceOf(Error);
  expect(thrown, 'an I/O error is not "restart the host"').not.toBeInstanceOf(PackRestartRequiredError);
  expect(thrown).toMatchObject({ code: 'ENOENT' });
  expect(() => assertNodePackReplaceable(dir), 'a failed claim leaves no binding behind').not.toThrow();

  const mapped = translateInstallError(thrown, 'fixture.lifetime-io', '1.0.0');
  expect(mapped.httpStatus).toBe(502);
  expect(mapped.details).toEqual({ packName: 'fixture.lifetime-io', version: '1.0.0' });
});

it('control: changed manifest bytes still refuse as pack_restart_required (409)', () => {
  const dir = packDir(true);
  let thrown: unknown;
  try { claimNodePackImport(dir, Buffer.from('{"different":true}\n')); } catch (err) { thrown = err; }
  expect(thrown).toBeInstanceOf(PackRestartRequiredError);
  const mapped = translateInstallError(thrown, 'fixture.lifetime-io', '1.0.0');
  expect(mapped.httpStatus).toBe(409);
  expect(mapped.details).toMatchObject({ reason: 'pack_restart_required' });
});
