/**
 * CRED-PICKER-REF-1 (the KEYS-REF-1 class, found by grade-tests wave 51) — the
 * builder's credential picker lists every stored key that NAMES the node's
 * provider, by the backend's rule.
 *
 * The picker kept only refs starting with `<provider>:` (or equal to it). That
 * hid the BYOK wizard's own `byok:<provider>` key (ADR 0517 fix B) and any
 * `<provider>-<label>` key, and with nothing left it said "No openai keys stored
 * yet" — telling the user to add a key they already have. The Keys page dropped
 * the same first-colon rule in KEYS-REF-1; this was the second reader of it.
 *
 * Parity: the SPA's `refNamesProvider` and the backend's
 * (`backend/typescript/src/aiProviders/credentialRefLadder.ts`, a pure module)
 * run over one literal fixture list, so the picker's filter cannot drift from
 * the backend's notion of "a key for this provider".
 *
 * Break it by restoring `r.startsWith(`${providerFilter}:`) || r === providerFilter`
 * in CredentialPickerInput, or by changing either `refNamesProvider` wrapper
 * (w53 probes `cp-filter-rule`, `cp-spa-wrapper`, `cp-backend-wrapper`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { refNamesProvider } from '../../../byok/lib/credentialRef.js';
import { refNamesProvider as backendRefNamesProvider } from '../../../../../../backend/typescript/src/aiProviders/credentialRefLadder.js';

const listStoredRefs = vi.fn<() => Promise<readonly string[]>>();
vi.mock('../../../byok/lib/byokClient.js', () => ({
  listStoredRefs: () => listStoredRefs(),
}));

const { CredentialPickerInput } = await import('../CredentialPickerInput.js');

const EMPTY = /No openai keys stored yet\./;

/** [ref, does it name `openai`?] — literal expectations, not computed. */
const OPENAI_FIXTURES: ReadonlyArray<readonly [string, boolean]> = [
  ['openai', true],
  ['openai:prod', true],
  ['openai-work', true],
  ['byok:openai', true],
  ['byok:openai:1760000000000', true],
  ['openaix', false],
  ['anthropic:default', false],
  ['byok:anthropic', false],
  ['my-openai', false],
  ['byok', false],
];

function view(providerFilter: string | undefined): void {
  render(
    <MemoryRouter>
      <CredentialPickerInput value={undefined} onChange={() => undefined} providerFilter={providerFilter} />
    </MemoryRouter>,
  );
}

/** The ref options the picker offers (the first option is the "none" placeholder, value ''). */
async function offered(): Promise<string[]> {
  const select = await screen.findByRole('combobox');
  return within(select).getAllByRole('option').map((o) => o.getAttribute('value') ?? '').filter((v) => v !== '');
}

beforeEach(() => { listStoredRefs.mockReset(); });
afterEach(cleanup);

describe('CRED-PICKER-REF-1 — which refs name a provider (the backend rule)', () => {
  // The per-ref rule itself (`refNamedProvider`) is pinned literal-by-literal in
  // `src/byok/lib/__tests__/credentialRef.test.ts` ('%s names %s (SPA rule)' + its own
  // SPA↔backend parity case); a per-ref it.each here duplicated it (w53 probe
  // `cp-rule-redundancy-COVER` reddened that file on the same sabotage). What only
  // THIS file pins is the single-provider WRAPPER, on both sides: the case below runs
  // the SPA and backend `refNamesProvider` over the fixtures and checks each against
  // the literal third column.
  it('the SPA and backend rules agree on every fixture', () => {
    const spa = OPENAI_FIXTURES.map(([ref]) => refNamesProvider(ref, 'openai'));
    const backend = OPENAI_FIXTURES.map(([ref]) => backendRefNamesProvider(ref, 'openai'));
    expect(spa).toEqual(backend);
    expect(spa).toEqual(OPENAI_FIXTURES.map(([, named]) => named));
  });
});

describe('CRED-PICKER-REF-1 — the picker offers every key that names its provider', () => {
  it('lists the wizard key and a dash-labelled key, and only openai keys, in stored order', async () => {
    listStoredRefs.mockResolvedValue(['anthropic:default', 'byok:openai', 'openaix', 'openai-work', 'openai:prod', 'byok:anthropic']);
    view('openai');
    expect(await offered()).toEqual(['byok:openai', 'openai-work', 'openai:prod']);
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it('a workspace whose ONLY openai key is the wizard one is not told it has none', async () => {
    listStoredRefs.mockResolvedValue(['byok:openai']);
    view('openai');
    expect(await offered()).toEqual(['byok:openai']);
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it('no key naming openai still says none are stored (positive control)', async () => {
    listStoredRefs.mockResolvedValue(['anthropic:default', 'openaix', 'my-openai']);
    view('openai');
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('with no provider filter every stored ref is offered', async () => {
    listStoredRefs.mockResolvedValue(['anthropic:default', 'byok:openai', 'my-key']);
    view(undefined);
    expect(await offered()).toEqual(['anthropic:default', 'byok:openai', 'my-key']);
  });
});
