/**
 * ADR 0601 — the notebooks workspace's failure behaviour (NBU-2, NBU-4, NBU-5).
 *
 * This is the FIRST test in `features/notebooks/` (NBU-15: the feature shipped
 * 581 lines of ingest, retrieval and note-taking with no frontend regression net,
 * so both defects below were a one-line change away from returning with nothing
 * going red). Three behaviours are pinned, each a data- or attribution-loss bug:
 *
 *  NBU-5  A failed Ask used to leave the PREVIOUS question's hits and citation
 *         chips rendered beneath the NEW query — evidence re-attributed to a
 *         question it never answered, on a surface whose entire value is
 *         grounded, cited retrieval. The user could then save that passage to
 *         notes as the answer to the wrong question.
 *  NBU-4  "Save to notes" beside a hit reused the COMPOSER's handler, whose
 *         unconditional `setNoteText('')` destroyed a note the user was midway
 *         through writing. Notes have no edit and no delete.
 *  NBU-2  A failed list read never set its list, so `null` — the LOADING
 *         sentinel — survived and the panel shimmered forever with no retry.
 *
 * The assertions target rendered TEXT and roles, not internal state, so they
 * survive a refactor of the state names and fail on the behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listSources = vi.fn();
const listNotes = vi.fn();
const listTransformations = vi.fn();
const searchNotebook = vi.fn();
const addNote = vi.fn();

vi.mock('../notebooksClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listSources: (...a: unknown[]) => listSources(...a),
  listNotes: (...a: unknown[]) => listNotes(...a),
  listTransformations: (...a: unknown[]) => listTransformations(...a),
  searchNotebook: (...a: unknown[]) => searchNotebook(...a),
  addNote: (...a: unknown[]) => addNote(...a),
  listTransformationTemplates: vi.fn(async () => []),
  ensureNotebookChat: vi.fn(async () => ({ conversationId: 'c1' })),
  ensureNotebook: vi.fn(async () => NOTEBOOK_FIXTURE),
}));

/** Hoisted above the mock factory's use site by `const` at module scope is not
 *  enough under vi.mock hoisting, so the fixture lives in the factory's closure
 *  via this module-level binding declared with `var`-like hoisting semantics. */
const NOTEBOOK_FIXTURE = {
  id: 'nb1', tenantId: 't1', orgId: 'o1', name: 'Research', collectionId: 'col1',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// Mounted through the REAL entry point the project Sources tab uses, rather than
// exporting the inner component just for the test.
import { ProjectSourcesPanel } from '../NotebooksPage.js';

const hit = (chunkId: string, text: string, title: string) => ({
  chunkId, documentId: `d-${chunkId}`, chunkIndex: 0, title, text, score: 0.9,
});

/** `ProjectSourcesPanel` provisions asynchronously (`ensureNotebook`), so the
 *  workspace is not in the DOM on the first tick. Await the composer before
 *  querying anything — otherwise every label lookup races the mount. */
const renderWorkspace = async () => {
  const r = render(<MemoryRouter><ProjectSourcesPanel projectId="nb1" /></MemoryRouter>);
  await screen.findByLabelText('New note');
  return r;
};

beforeEach(() => {
  listSources.mockResolvedValue([]);
  listNotes.mockResolvedValue([]);
  listTransformations.mockResolvedValue([]);
  searchNotebook.mockResolvedValue({ hits: [], citations: [] });
  addNote.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('NBU-5 — a failed Ask never leaves the previous answer under the new question', () => {
  it('clears the prior hits + citations and states the failure in place', async () => {
    searchNotebook.mockResolvedValueOnce({
      hits: [hit('c1', 'Mitochondria are the powerhouse of the cell.', 'Biology paper')],
      citations: [{ documentId: 'd-c1', title: 'Biology paper' }],
    });
    await renderWorkspace();

    // Question 1 succeeds.
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'what is a mitochondrion' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));
    await screen.findByText(/powerhouse of the cell/i);
    expect(screen.getByText('Biology paper', { selector: '.chip' })).toBeTruthy();

    // Question 2 fails.
    searchNotebook.mockRejectedValueOnce(new Error('search backend is down'));
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'unrelated question' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    // THE defect: this passage used to still be on screen, now visually
    // attributed to "unrelated question".
    await waitFor(() => expect(screen.queryByText(/powerhouse of the cell/i)).toBeNull());
    expect(screen.queryByText('Biology paper', { selector: '.chip' })).toBeNull();
    // …and the surface says so rather than going quietly blank.
    expect(screen.getByText(/couldn't run that search/i)).toBeTruthy();
    expect(screen.getByText('search backend is down')).toBeTruthy();
  });

  it('the stale answer is gone WHILE THE NEW ASK IS IN FLIGHT, before any failure is known', async () => {
    // This case exists because the test above does NOT witness `setAnswer(null)`.
    // MEASURED: deleting that line leaves the test above GREEN, because the
    // `askFailed` StateCard short-circuits the answer branch and hides the stale
    // hits for a different reason. The assertion was catching a NEIGHBOUR.
    //
    // The in-flight window is the only input that separates the two: `askFailed`
    // is still null, so nothing short-circuits, and the previous question's hits
    // are on screen if and only if `answer` was not cleared.
    searchNotebook.mockResolvedValueOnce({
      hits: [hit('c1', 'Mitochondria are the powerhouse of the cell.', 'Biology paper')],
      citations: [{ documentId: 'd-c1', title: 'Biology paper' }],
    });
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'q1' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));
    await screen.findByText(/powerhouse of the cell/i);

    // A search that never settles — the panel stays in the in-flight state.
    searchNotebook.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'q2' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    await waitFor(() => expect(screen.queryByText(/powerhouse of the cell/i)).toBeNull());
    expect(screen.queryByText('Biology paper', { selector: '.chip' })).toBeNull();
    // No failure has occurred, so the failure card must NOT be the reason it is gone.
    expect(screen.queryByText(/couldn't run that search/i)).toBeNull();
  });
});

describe('NBU-4 — "Save to notes" does not destroy the note being composed', () => {
  it('saves the hit and LEAVES the composer text intact', async () => {
    searchNotebook.mockResolvedValueOnce({
      hits: [hit('c1', 'A supporting quote worth filing.', 'Source A')],
      citations: [{ documentId: 'd-c1', title: 'Source A' }],
    });
    await renderWorkspace();

    // The user is midway through writing a synthesis.
    const composer = screen.getByLabelText('New note') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'My half-written synthesis paragraph' } });

    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'quote' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));
    await screen.findByText(/a supporting quote worth filing/i);

    fireEvent.click(screen.getByRole('button', { name: /save to notes/i }));
    await waitFor(() => expect(addNote).toHaveBeenCalledWith('nb1', 'A supporting quote worth filing.', 'third-party'));

    // THE defect: the composer used to be emptied by this click.
    expect(composer.value).toBe('My half-written synthesis paragraph');
  });

  it('CONTROL — the COMPOSER lane still clears itself on a successful submit', async () => {
    await renderWorkspace();
    const composer = screen.getByLabelText('New note') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'A note I typed myself' } });
    fireEvent.click(screen.getByRole('button', { name: /^add note$/i }));

    await waitFor(() => expect(addNote).toHaveBeenCalledWith('nb1', 'A note I typed myself', 'authored'));
    await waitFor(() => expect(composer.value).toBe(''));
  });

  it('CONTROL — a FAILED composer submit KEEPS the text (nothing was saved to lose it to)', async () => {
    addNote.mockRejectedValueOnce(new Error('write failed'));
    await renderWorkspace();
    const composer = screen.getByLabelText('New note') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Precious unsaved note' } });
    fireEvent.click(screen.getByRole('button', { name: /^add note$/i }));

    await waitFor(() => expect(addNote).toHaveBeenCalled());
    expect(composer.value).toBe('Precious unsaved note');
  });
});

describe('NBU-2 — a failed list read resolves to a stated failure, never a permanent skeleton', () => {
  it('each panel states ITS OWN failure with a retry, and does not claim "none yet"', async () => {
    listSources.mockRejectedValueOnce(new Error('sources read 500'));
    listNotes.mockRejectedValueOnce(new Error('notes read 500'));
    await renderWorkspace();

    expect(await screen.findByText(/couldn't load your sources/i)).toBeTruthy();
    expect(screen.getByText('sources read 500')).toBeTruthy();
    // Both failures are named — the single shared string used to erase all but one.
    expect(screen.getByText(/couldn't load your notes/i)).toBeTruthy();
    expect(screen.getByText('notes read 500')).toBeTruthy();

    // A failed read must NEVER make the positive claim (StateCard's own rule).
    expect(screen.queryByText(/no sources yet/i)).toBeNull();
    expect(screen.queryByText(/no notes yet/i)).toBeNull();

    // The third panel read fine and is unaffected — failure is per panel.
    expect(screen.getByText(/no transformations yet/i)).toBeTruthy();

    // And there is a way out.
    expect(screen.getAllByRole('button', { name: /try again/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('retry re-reads and clears that panel only', async () => {
    listSources.mockRejectedValueOnce(new Error('sources read 500'));
    await renderWorkspace();
    await screen.findByText(/couldn't load your sources/i);

    listSources.mockResolvedValueOnce([
      { documentId: 'd1', title: 'Recovered source', chunkCount: 3, createdAt: '2026-01-01T00:00:00.000Z', contextLevel: 'full', hasSummary: false },
    ]);
    fireEvent.click(screen.getAllByRole('button', { name: /try again/i })[0]!);

    expect(await screen.findByText('Recovered source')).toBeTruthy();
    expect(screen.queryByText(/couldn't load your sources/i)).toBeNull();
  });

  it('a successful ASK does NOT clear an unrelated panel\'s load failure', async () => {
    // The old shape: one shared `error` string, cleared only inside `ask()`. A
    // user running an unrelated search made the banner vanish while the sources
    // skeleton was still spinning — an honest failure turned into a calm
    // permanent load. This is the assertion that pins it shut.
    listSources.mockRejectedValueOnce(new Error('sources read 500'));
    await renderWorkspace();
    await screen.findByText(/couldn't load your sources/i);

    searchNotebook.mockResolvedValueOnce({
      hits: [hit('c1', 'An unrelated but successful result.', 'Other doc')],
      citations: [{ documentId: 'd-c1', title: 'Other doc' }],
    });
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'anything' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));
    await screen.findByText(/an unrelated but successful result/i);

    expect(screen.getByText(/couldn't load your sources/i)).toBeTruthy();
  });
});

describe('NBU-20 (ADR 0601 § Corrections / LOW-9) — a failed Ask announces ONCE, in ONE channel', () => {
  it('states itself in the StateCard and fires NO toast', async () => {
    // `StateCard`'s docblock: the card picks exactly one mechanism. This lane was
    // doing both — a polite `announce` carrying the TITLE, plus a `toast.error`
    // (`role="alert"`, assertive) carrying the MESSAGE — so one failure produced
    // two announcements at two politeness levels with two different strings, and
    // the assertive one interrupted the polite one.
    const { toast } = await import('../../../ui/toast.js');
    searchNotebook.mockRejectedValueOnce(new Error('search backend is down'));
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'anything' } });
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }));

    // The card is the channel…
    expect(await screen.findByText(/couldn't run that search/i)).toBeTruthy();
    expect(screen.getByText('search backend is down')).toBeTruthy();
    // …and it is the ONLY channel.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('CONTROL — a failed WRITE action still toasts (the distinction StateCard draws)', async () => {
    // The cure must not be "delete every toast". A failed ACTION is transient and
    // owns no surface of its own; a failed panel READ owns the region it emptied.
    // Removing the toast from `addNote` too would leave a failed save silent.
    const { toast } = await import('../../../ui/toast.js');
    addNote.mockRejectedValueOnce(new Error('write failed'));
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('New note'), { target: { value: 'A note I typed myself' } });
    fireEvent.click(screen.getByRole('button', { name: /^add note$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});

describe('NBU-19 (ADR 0601 § Corrections / LOW-10) — a retry gives feedback in SOME channel', () => {
  it('the retry button goes busy while it runs, so a REPEAT failure is observable', async () => {
    // THE defect: on a repeat failure the StateCard never unmounts, its announce
    // effect is keyed `[announce, title]` with a constant title, and the button
    // carried no disabled/busy state — so the screen was byte-identical before
    // and after the click and nothing was announced. A user could not tell a
    // retry that ran and failed from a click that missed the button.
    listSources.mockRejectedValueOnce(new Error('sources read 500'));
    await renderWorkspace();
    await screen.findByText(/couldn't load your sources/i);

    const retry = (): HTMLButtonElement => screen.getAllByRole<HTMLButtonElement>('button', { name: /try again/i })[0]!;
    expect(retry().getAttribute('aria-busy'), 'idle before the click').toBeNull();
    expect(retry().disabled).toBe(false);

    // A read that never settles — the in-flight window is the whole point.
    let release: (v: unknown) => void = () => {};
    listSources.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    fireEvent.click(retry());

    await waitFor(() => expect(retry().getAttribute('aria-busy')).toBe('true'));
    expect(retry().disabled, 'a second click must be impossible').toBe(true);

    // …and it comes back when the read lands, rather than latching busy forever.
    release([]);
    await waitFor(() => expect(screen.queryByText(/couldn't load your sources/i)).toBeNull());
  });

  it('a REPEAT failure leaves the button usable again (the busy state is not a trap)', async () => {
    listSources.mockRejectedValueOnce(new Error('sources read 500'));
    await renderWorkspace();
    await screen.findByText(/couldn't load your sources/i);

    listSources.mockRejectedValueOnce(new Error('sources read 500 again'));
    fireEvent.click(screen.getAllByRole('button', { name: /try again/i })[0]!);

    // The failure text changes, so this also witnesses that the retry RAN.
    expect(await screen.findByText('sources read 500 again')).toBeTruthy();
    const retry = screen.getAllByRole<HTMLButtonElement>('button', { name: /try again/i })[0]!;
    expect(retry.getAttribute('aria-busy')).toBeNull();
    expect(retry.disabled).toBe(false);
  });

  it('the OTHER panels’ retries stay idle — the busy flag is per panel, not global', async () => {
    listSources.mockRejectedValueOnce(new Error('sources read 500'));
    listNotes.mockRejectedValueOnce(new Error('notes read 500'));
    await renderWorkspace();
    await screen.findByText(/couldn't load your sources/i);
    await screen.findByText(/couldn't load your notes/i);

    listSources.mockImplementationOnce(() => new Promise(() => {}));
    const buttons = (): HTMLButtonElement[] => screen.getAllByRole<HTMLButtonElement>('button', { name: /try again/i });
    fireEvent.click(buttons()[0]!);

    await waitFor(() => expect(buttons()[0]!.getAttribute('aria-busy')).toBe('true'));
    expect(buttons()[1]!.getAttribute('aria-busy'), 'the notes retry must not go busy').toBeNull();
    expect(buttons()[1]!.disabled).toBe(false);
  });
});
