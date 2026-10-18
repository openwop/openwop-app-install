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
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { SelectField } from '../Field.js';

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

/**
 * The disclosure gated on THIS flag announces — not "some Notice in the file".
 * A file-wide count cannot fail when the named disclosure is unwired while
 * another Notice in the file still announces (StrategyDetailPage has 9 announcing
 * notices; w49 probes nafr-strategy / nafr-chat-roster stayed green under the
 * old `>= 1`). Anchored on the flag the same way the DocumentsPage case is.
 */
const flagNoticeAnnounces = (src: string, flag: string): boolean =>
  new RegExp(`\\b${flag}\\b[^\\n]*\\?\\s*\\(?\\s*<Notice[^>]*\\bannounce\\s*[:=]`).test(src);

/**
 * `ProjectMembersTab`'s `directoryFailed` disclosure is no longer a Notice: since
 * d7a4bab8e (projects R2) it is the add-member `SelectField`'s `error`, which
 * `ui/Field` renders as `role="alert"` and wires into the control's
 * `aria-describedby` + `aria-invalid`. The row keeps `directoryFailed` as its
 * subject and asserts the disclosure where it lives now.
 */
const FIELD_ERROR_DISCLOSURES: ReadonlySet<string> = new Set(['directoryFailed']);
const fieldErrorCarries = (src: string, flag: string): boolean =>
  new RegExp(`<SelectField[\\s\\S]{0,400}?\\{\\.\\.\\.\\(${flag} \\? \\{ error: t\\(`).test(src);

describe('failed-read notices announce', () => {
  it.each(WIRED)('%s announces its %s disclosure', (file, flag) => {
    const s = read(file);
    expect(announced(file)).toBeGreaterThanOrEqual(1);
    if (FIELD_ERROR_DISCLOSURES.has(flag)) {
      expect(fieldErrorCarries(s, flag)).toBe(true);
      expect(flagNoticeAnnounces(s, flag)).toBe(false); // it moved; don't double-disclose
      // …and a Field error is announced + associated (the contract the row now relies on).
      try {
        render(createElement(SelectField, { label: 'Person', error: 'Directory unavailable', value: '', onChange: () => {} },
          createElement('option', { value: '' }, '—')));
        const select = screen.getByLabelText('Person');
        expect(screen.getByRole('alert').textContent).toBe('Directory unavailable');
        expect(select.getAttribute('aria-invalid')).toBe('true');
        const describedBy = select.getAttribute('aria-describedby') ?? '';
        expect(describedBy.split(' ').map((id) => document.getElementById(id)?.textContent)).toContain('Directory unavailable');
      } finally {
        cleanup();
      }
    } else {
      expect(flagNoticeAnnounces(s, flag)).toBe(true);
    }
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
