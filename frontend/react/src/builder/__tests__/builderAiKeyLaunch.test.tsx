/**
 * ADR 0712 P2 (run-time AI credential choice), driven through the real BuilderShell
 * launch path: the real store, serializer and RunInputsDialog. Only the transport is stubbed.
 *
 * What it guards, and the sabotages that turn it red (wave 94, w94g2-bk-*):
 *  - The chosen stored key goes out ONLY as `configurable.ai.credentialRef` (ADR 0712).
 *    A blank choice sends no `configurable` at all. Reds when createRun drops `configurable`,
 *    or when RunInputsDialog sends an empty-key `configurable`.
 *  - The register is a CAS against the loaded head (`baseRevision`, ADR 0770 D5), and the run
 *    is a draft run (`metadata.launch:'draft'`, ADR 0474 P1b). Reds when either is dropped.
 *  - The key chooser opens only for graphs that may use AI. A non-AI graph runs directly. A
 *    declared canonical `credentialRef` variable is the only chooser, so no second AI-key field
 *    appears. Reds when `mayUseAi` is forced either way, or when `separateKey` ignores the declared
 *    variable.
 *  - An identity change (fireAuthChanged) closes the pending dialog. Reds when BuilderShell's
 *    auth listener stops clearing `runOptions`. A submit in the same turn as the identity change
 *    is refused before any register. ONE guard reaches this: the `request.identity` check in the
 *    dialog's onRun. `runOnce` captures the NEW identity, so its later checks cannot catch it.
 *  - A graph edited while the dialog is open is refused before any register. THREE copies
 *    (dialog onRun, the runOnce pre-check, the write-turn check) show the same
 *    `runOptionsChanged` text, so a single-copy sabotage reads vacuous. The witness breaks all three
 *    through `launchFingerprint`.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../featureToggles/__testing__/makeFeatureAccess.js';
import type { createRun } from '../../client/runsClient.js';
import type { registerWorkflow } from '../persistence/registerClient.js';
import type { listStoredRefs } from '../../byok/lib/byokClient.js';
import type { UseAuth } from '../../auth/useAuth.js';
import type { WorkflowCollabState } from '../collab/workflowCollabSession.js';
const api = vi.hoisted(() => ({
  create: vi.fn<typeof createRun>(async () => ({ runId: 'local-run', status: 'pending', eventsUrl: '/runs/local-run/events' })),
  register: vi.fn<typeof registerWorkflow>(async () => ({ workflowId: 'local-research', nodeCount: 1, revision: 'r2' })),
  refs: vi.fn<typeof listStoredRefs>(async () => ['google:myndhyve-google']),
}));
const signedOut: UseAuth = { user: null, loading: false, isConfigured: false, signIn: { google: async () => {}, github: async () => {} }, signOut: async () => {} };
const collabOff: WorkflowCollabState = { active: false };
vi.mock('../../client/runsClient.js', () => ({ createRun: api.create, listWorkflowRunCosts: vi.fn(async () => []), getCapabilities: vi.fn(async () => ({})) }));
vi.mock('../persistence/registerClient.js', () => ({ registerWorkflow: api.register }));
vi.mock('../../byok/lib/byokClient.js', () => ({ listStoredRefs: api.refs }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => signedOut }));
vi.mock('../../featureToggles/FeatureAccessContext.js', async orig => ({ ...await orig<Record<string, unknown>>(), useFeatureAccess: () => makeFeatureAccess({ enabled: false }) }));
vi.mock('../collab/workflowCollabSession.js', () => ({ probeWorkflowCollabAvailable: vi.fn(async () => false), useWorkflowCollabSession: () => collabOff }));
const peers: never[] = [];
vi.mock('../collab/useWorkflowCollabPresence.js', () => ({ useWorkflowCollabPresence: () => ({ peers }) }));
vi.mock('../../canvas/CanvasSurfaceShell.js', () => ({ CanvasSurfaceShell: ({ config }: { config: { bar: () => ReactNode } }) => <>{config.bar()}</> }));
vi.mock('../../workflows/workflowsClient.js', () => ({ listWorkflowSummaries: vi.fn(async () => []), promoteWorkflow: vi.fn() }));
vi.mock('../../workflows/fleetInsightsClient.js', () => ({ fetchFleetStats: vi.fn(async () => ({ workflows: [] })), fetchWorkflowEstimate: vi.fn(async () => null) }));
vi.mock('../debugSession.js', () => ({ loadDebugSessionFromServer: vi.fn(async () => null), prefillDebugSessionFromRun: vi.fn() }));
vi.mock('../../client/streamsClient.js', () => ({ subscribeToRun: vi.fn(() => ({ close: () => {} })) }));
vi.mock('../ProposalBanner.js', () => ({ ProposalBanner: () => null }));
import { BuilderShell } from '../BuilderShell.js';
import { useBuilderStore } from '../store/builderStore.js';
import { fireAuthChanged } from '../../client/config.js';
beforeEach(() => {
  api.create.mockClear(); api.register.mockClear(); api.refs.mockClear();
  useBuilderStore.setState({ workflowId: 'local-research', name: 'Research', nodes: [{ id: 'generate', kind: 'noop', name: 'Generate', position: { x: 0, y: 0 }, config: {}, inputs: { provider: 'google', model: 'gemini-3.8-flash' } }], edges: [], defaultInputs: '{"custom":{"keep":true}}', variables: [], baseRevision: 'r1', overlay: null });
});
afterEach(cleanup);
function keySelect(element: HTMLElement): HTMLSelectElement {
  if (!(element instanceof HTMLSelectElement)) throw new Error('AI key chooser must be a select');
  return element;
}
it('launches real builder with chosen labeled key, preserved defaults, CAS and draft marker', async () => {
  render(<MemoryRouter><BuilderShell onNewWorkflow={() => {}} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  const key = await screen.findByLabelText('AI key for this run');
  await screen.findByRole('option', { name: 'google:myndhyve-google' });
  expect(api.create).not.toHaveBeenCalled(); expect(api.register).not.toHaveBeenCalled();
  fireEvent.change(key, { target: { value: 'google:myndhyve-google' } });
  const confirm = screen.getAllByRole('button', { name: 'Run' }).at(-1);
  if (!confirm) throw new Error('Run dialog confirm missing');
  fireEvent.click(confirm);
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
  expect(api.create).toHaveBeenCalledWith({ workflowId: 'local-research', inputs: { custom: { keep: true } }, configurable: { version: 1, ai: { credentialRef: 'google:myndhyve-google' } }, metadata: { launch: 'draft' } });
  expect(api.register.mock.calls[0]?.[1]).toMatchObject({ baseRevision: 'r1' });
});
it('normal non-AI Run remains direct and declares no key', async () => {
  useBuilderStore.setState({ nodes: [{ id: 'format', kind: 'noop', name: 'Format', position: { x: 0, y: 0 }, config: {} }] });
  render(<MemoryRouter><BuilderShell onNewWorkflow={() => {}} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
  expect(api.create.mock.calls[0]?.[0]).not.toHaveProperty('configurable'); expect(api.refs).not.toHaveBeenCalled();
});
it('canonical optional credential variable without required flag remains the sole chooser', async () => {
  useBuilderStore.setState({ variables: [{ name: 'credentialRef', type: 'string' }] });
  render(<MemoryRouter><BuilderShell onNewWorkflow={() => {}} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  await waitFor(() => expect(screen.getByLabelText('Credential ref').tagName).toBe('SELECT'));
  expect(screen.queryByLabelText('AI key for this run')).toBeNull();
});
it('workspace changes cancel the pending builder key choice without starting a run', async () => {
  render(<MemoryRouter><BuilderShell onNewWorkflow={() => {}} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  await screen.findByRole('option', { name: 'google:myndhyve-google' });
  act(() => fireAuthChanged());
  expect(screen.queryByLabelText('AI key for this run')).toBeNull(); expect(api.create).not.toHaveBeenCalled(); expect(api.register).not.toHaveBeenCalled();
});
it('refuses a graph edited while the key dialog was open before any registration', async () => {
  render(<MemoryRouter><BuilderShell onNewWorkflow={() => {}} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  await screen.findByRole('option', { name: 'google:myndhyve-google' });
  act(() => useBuilderStore.getState().setName('Changed research'));
  const confirm = screen.getAllByRole('button', { name: 'Run' }).at(-1);
  if (!confirm) throw new Error('Run dialog confirm missing');
  fireEvent.click(confirm);
  expect(await screen.findByText('The workflow changed while run options were open. Review it and run again.')).toBeTruthy();
  expect(api.register).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
});

it('refuses a blank key choice submitted in the same turn as an identity change', async () => {
  render(<MemoryRouter><BuilderShell onNewWorkflow={() => {}} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  const key = await screen.findByLabelText('AI key for this run');
  await screen.findByRole('option', { name: 'google:myndhyve-google' });
  expect(keySelect(key).value).toBe('');
  const form = key.closest('form');
  if (!form) throw new Error('Real run options form missing');
  // The auth callback invalidates synchronously; React has not unmounted the
  // previous dialog when its form submits in this same action (ADR 0712).
  await act(async () => {
    fireAuthChanged();
    fireEvent.submit(form);
  });
  expect(api.register).not.toHaveBeenCalled();
  expect(api.create).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('AI key for this run')).toBeNull();
});

it('keeps an unchanged blank key choice as the normal default launch', async () => {
  render(<MemoryRouter><BuilderShell onNewWorkflow={() => {}} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  const key = await screen.findByLabelText('AI key for this run');
  await screen.findByRole('option', { name: 'google:myndhyve-google' });
  expect(keySelect(key).value).toBe('');
  const form = key.closest('form');
  if (!form) throw new Error('Real run options form missing');
  await act(async () => { fireEvent.submit(form); });
  expect(api.register).toHaveBeenCalledTimes(1);
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.create).toHaveBeenCalledWith({ workflowId: 'local-research', inputs: { custom: { keep: true } }, metadata: { launch: 'draft' } });
});
