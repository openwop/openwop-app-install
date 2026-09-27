/**
 * Failed-read disclosures must announce. Tranche 3.
 *
 * `success` (tranche 2) had a structural tell: the render shape identified an
 * action result. `warning`/`info` do not — of 183 silent notices only 2 gate on
 * an action variable, and roughly 169 are static informational furniture that
 * SHOULD stay silent. Announcing those would fire on every mount and every
 * route back, which is a defect in the other direction.
 *
 * The criterion that does hold: **gated on a failed-read flag**
 * (`…Failed` / `…Error` / `…Unavailable` / `…Stale`). Those notices exist to
 * say "we could not get this data", and a screen-reader user who never hears
 * them has no way to know the page is showing an incomplete answer — the
 * "absence is a claim" family the whole programme is about.
 *
 * Twelve sites match. Four already announced. Seven are wired here. The eighth
 * is deliberately NOT wired — see below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/** Accepts both legal idioms — the plain prop and the conditional spread. */
const announced = (p: string): number => (read(p).match(/<Notice[^>]*\bannounce\s*[:=]/g) ?? []).length;

const WIRED: ReadonlyArray<readonly [string, string]> = [
  ['features/evals/ArenaPage.tsx', 'orgsUnavailable'],
  ['features/projects/ProjectChatTab.tsx', 'rosterFailed'],
  ['features/projects/ProjectMembersTab.tsx', 'directoryFailed'],
  ['features/users/UsersPage.tsx', 'meFailed'],
  ['features/commerce-connect/CommerceConnectPage.tsx', 'statsFailed'],
  ['features/strategy/StrategyDetailPage.tsx', 'projectsFailed'],
  ['features/environments/EnvironmentsPage.tsx', 'envError'],
];

describe('failed-read notices announce', () => {
  it.each(WIRED)('%s announces its %s disclosure', (file) => {
    expect(announced(file)).toBeGreaterThanOrEqual(1);
  });

  /**
   * `announce()` keeps ONE polite slot, and unlike tranche 2's action results —
   * which are sequential by construction, one user action at a time — FAILED
   * READS GENUINELY CO-OCCUR: a single page load fires several requests and
   * several can fail together. `DocumentsPage` sets `accessFailed` and
   * `canvasesFailed` from independent handlers in the same load effect, and
   * `canvasesFailed` already announces. Wiring the second would mean whichever
   * rendered last silently replaced the other.
   */
  it('DocumentsPage: the two CO-OCCURRING disclosures share one slot; the modal one is separate', () => {
    const s = read('features/documents/DocumentsPage.tsx');
    // Asserting WHICH notices announce, not how many. The old form was
    // `toBe(1)`, which encoded a page state rather than the rule — and it broke
    // the moment a third, unrelated disclosure was correctly wired (2026-08-11).
    // A count cannot distinguish "the right one announces" from "some one does".
    expect(s).toMatch(/canvasesFailed \? <Notice[^>]*announce=/);
    expect(s).not.toMatch(/accessFailed \? <Notice[^>]*announce=/);

    // `projectsFailed` DOES announce, and that does not contend for the polite
    // slot: it renders inside `<Modal label={t('addToProject')}>`, which opens on
    // an explicit user action AFTER load. The co-occurrence argument above is
    // about two handlers in ONE load effect; a modal is sequential by
    // construction, the same reasoning tranche 2 uses for action results.
    expect(s).toMatch(/projectsFailed \? \(\s*<Notice[^>]*announce=/);
    expect(announced('features/documents/DocumentsPage.tsx')).toBe(2);
  });

  /**
   * `EnvironmentsPage` interpolates a RAW SERVER ERROR into its visible copy.
   * `Notice.tsx` is explicit that an announcement takes an explicit message so
   * server blobs stay out of it, so this one speaks a clean sentence rather
   * than the interpolated string it displays.
   */
  it('EnvironmentsPage announces a clean sentence, not the server error blob', () => {
    const s = read('features/environments/EnvironmentsPage.tsx');
    expect(s).toContain("announce={t('staleAfterRefreshAnnounce')}");
    expect(s).not.toMatch(/announce=\{t\('staleAfterRefresh',/);
  });
});
