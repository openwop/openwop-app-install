/**
 * `<Trans components>` must be an ARRAY when the string uses numbered tags (#5396).
 *
 * Under react-i18next 16.6.6 the OBJECT form with numeric keys,
 * `components={{ 0: <strong /> }}`, renders the `<0>` element's text with no
 * element around it. The cause is in `TransWithoutContext.js`:
 *
 *   - `isComponentsMap` accepts an object as a named-tag map only when EVERY key
 *     is non-numeric. `{ 0: … }` fails that, so `Trans` hands the object to
 *     `renderNodes` as if it were the indexed children list.
 *   - `mapAST` reads that list through `getAsArray`, which wraps a non-array as
 *     `[obj]`. Tag `<0>` then resolves to `reactNodes[0]`, which is the whole
 *     object rather than `obj[0]`. The object is not an element and has no
 *     children, so the branch that handles it pushes only the text.
 *   - Tags `<1>` and up miss `reactNodes[n]` and fall through to
 *     `rootReactNode[0][node.name]`, which happens to be `obj[n]`. They render,
 *     but only because of that fallback.
 *
 * So only the `<0>` slot disappeared, everywhere the object form was used: the
 * "inert" emphasis on /cli, the email page's "create one on the CRM page" link,
 * the `<code>` path on the 404 page, and about 65 more. The array form indexes
 * `reactNodes[n]` directly and has no such gap. Sites whose strings skip `<0>`
 * hold the unused slots with `<></>`.
 *
 * Sabotage-witnessed (each reds the named case):
 *   - reverting CliPage's cliCatProposals to `components={{ 0: <strong /> }}`
 *     reds "/cli keeps <strong>inert</strong>" and the ratchet;
 *   - reverting NotFoundPage to `components={{ 0: <code /> }}` reds the 404 case;
 *   - reverting CliPage's cliSourceBody to the object form reds the link case;
 *   - dropping the `\s*` from the ratchet pattern lets the multi-line
 *     `components={{\n  0: …` shape through (the pattern-shape case reds);
 *   - a scan that reads no files reds the "not vacuous" case.
 * (Re-measured in /grade-tests wave 80: each of these reds its case, and each
 * reverted call site also reds the ratchet.)
 *
 * What the ratchet does NOT enforce (human ask, wave 80): it matches only an
 * object whose FIRST key is numeric. A mixed object such as
 * `components={{ link: <a />, 0: <b /> }}` also fails `isComponentsMap` and
 * would drop `<0>`, but passes the scan. Its non-vacuity floor is `> 20` files
 * against 32 measured at `0a3da6141`. Neither is changed here.
 *
 * The first four cases pin react-i18next itself: no in-repo sabotage reaches
 * them, and case 1 going red after a library upgrade is the signal that the
 * ratchet could relax.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Trans } from 'react-i18next';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import '../index.js';
import { CliPage } from '../../CliPage.js';
import { NotFoundPage } from '../../NotFoundPage.js';

afterEach(cleanup);

describe('react-i18next 16.6.6: object vs array `components`', () => {
  it('the object form with key 0 drops the <0> element (why the ratchet below exists)', () => {
    const { container } = render(
      <Trans i18nKey="cliCatProposals" ns="chrome" components={{ 0: <strong /> }} />,
    );
    expect(container.textContent).toContain('lands inert;');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('the object form still renders <1> and up, through the fallback lookup', () => {
    const { container } = render(
      <Trans i18nKey="noAgentsInstalled" ns="chat" components={{ 1: <strong /> }} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('Agents');
  });

  it('the array form renders the <0> element', () => {
    const { container } = render(
      <Trans i18nKey="cliCatProposals" ns="chrome" components={[<strong />]} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('inert');
  });

  it('a sparse array (placeholder at 0) renders the <1> element', () => {
    const { container } = render(
      <Trans i18nKey="noAgentsInstalled" ns="chat" components={[<></>, <strong />]} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('Agents');
  });
});

describe('converted call sites render their elements', () => {
  it('/cli keeps <strong>inert</strong> (cliCatProposals)', () => {
    const { container } = render(<MemoryRouter><CliPage /></MemoryRouter>);
    const row = [...container.querySelectorAll('td')].find((td) => td.textContent?.startsWith('Learning proposals'));
    expect(row?.querySelector('strong')?.textContent).toBe('inert');
  });

  it('/cli keeps the npm link in cliSourceBody', () => {
    render(<MemoryRouter><CliPage /></MemoryRouter>);
    const link = screen.getByText('@openwop/cli', { selector: 'a' });
    expect(link.getAttribute('href')).toBe('https://www.npmjs.com/package/@openwop/cli');
  });

  it('the 404 page wraps the path in <code>', () => {
    render(<MemoryRouter initialEntries={['/no-such-page']}><NotFoundPage /></MemoryRouter>);
    expect(screen.getByText('/no-such-page').tagName).toBe('CODE');
  });
});

/** Object-form `components` with a numeric first key, on one line or several. */
const OBJECT_FORM = /components=\{\{\s*['"]?\d+['"]?\s*:/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...sources(p)); continue; }
    if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('RATCHET: no object-form numeric `components` in src', () => {
  const SRC = join(process.cwd(), 'src');
  const files = sources(SRC);

  it('the pattern catches both the one-line and the multi-line shape', () => {
    expect(OBJECT_FORM.test('<Trans components={{ 0: <b /> }} />')).toBe(true);
    expect(OBJECT_FORM.test('<Trans\n  components={{\n    0: <b />,\n  }}\n/>')).toBe(true);
    expect(OBJECT_FORM.test('<Trans components={[<b />]} />')).toBe(false);
  });

  it('the scan reads the converted sites (not vacuous)', () => {
    const arrayForm = files.filter((f) => /components=\{\[/.test(readFileSync(f, 'utf8')));
    expect(arrayForm.length).toBeGreaterThan(20);
  });

  it('finds no `components={{ <digit>:` outside tests', () => {
    const offenders = files
      .filter((f) => OBJECT_FORM.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
