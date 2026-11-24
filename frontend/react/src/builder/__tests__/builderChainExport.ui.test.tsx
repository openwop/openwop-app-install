/** Real mounted export handlers; layout/auth/services are peripheral seams.
 * Requires2768 proposal + IPC helpers. Native UNRUN. */
import type { UseAuth } from '../../auth/useAuth.js';
import type { WorkflowCollabState } from '../collab/workflowCollabSession.js';
import type { SurfaceShellConfig } from '../../canvas/CanvasSurfaceShell.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../featureToggles/__testing__/makeFeatureAccess.js';
const effects = vi.hoisted(() => ({
  create: vi.fn(async () => { throw new Error('Forbidden run'); }),
  register: vi.fn(async () => { throw new Error('Forbidden workflow write'); }),
  promote: vi.fn(async () => { throw new Error('Forbidden promotion'); }),
  stream: vi.fn(() => { throw new Error('Forbidden stream'); }),
  refs: vi.fn(async () => { throw new Error('Forbidden credential read'); }),
}));
const signedOut: UseAuth = { user: null, loading: false, isConfigured: false,
  signIn: { google: async () => {}, github: async () => {} }, signOut: async () => {} };
const collabOff: WorkflowCollabState = { active: false };
const peers: never[] = [];
vi.mock('../../client/runsClient.js', () => ({ createRun: effects.create, listWorkflowRunCosts: vi.fn(async () => []), getCapabilities: vi.fn(async () => ({})) }));
vi.mock('../persistence/registerClient.js', () => ({ registerWorkflow: effects.register }));
vi.mock('../../byok/lib/byokClient.js', () => ({ listStoredRefs: effects.refs }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => signedOut }));
vi.mock('../../featureToggles/FeatureAccessContext.js', async original => ({ ...await original<Record<string, unknown>>(), useFeatureAccess: () => makeFeatureAccess({ enabled: false }) }));
vi.mock('../collab/workflowCollabSession.js', () => ({ probeWorkflowCollabAvailable: vi.fn(async () => false), useWorkflowCollabSession: () => collabOff }));
vi.mock('../collab/useWorkflowCollabPresence.js', () => ({ useWorkflowCollabPresence: () => ({ peers }) }));
vi.mock('../../canvas/CanvasSurfaceShell.js', () => ({
  CanvasSurfaceShell: ({ config }: { config: Pick<SurfaceShellConfig, 'bar'> }) => <>{config.bar({ announce: () => undefined })}</>,
}));
vi.mock('../../workflows/workflowsClient.js', () => ({ listWorkflowSummaries: vi.fn(async () => []), promoteWorkflow: effects.promote }));
vi.mock('../../workflows/fleetInsightsClient.js', () => ({ fetchFleetStats: vi.fn(async () => ({ workflows: [] })), fetchWorkflowEstimate: vi.fn(async () => null) }));
vi.mock('../debugSession.js', () => ({ loadDebugSessionFromServer: vi.fn(async () => null), prefillDebugSessionFromRun: vi.fn() }));
vi.mock('../../client/streamsClient.js', () => ({ subscribeToRun: effects.stream }));
vi.mock('../ProposalBanner.js', () => ({ ProposalBanner: () => null }));
import { BuilderShell } from '../BuilderShell.js';
import { useBuilderStore } from '../store/builderStore.js';
import { GlobalLiveRegion } from '../../ui/announce.js';
import { catalogEntry, catalogEntryByTypeId, isDynamicCatalogLoaded, loadDynamicCatalog } from '../palette/catalogRegistry.js';
import { chainExportCatalog } from './support/builderContractClient.js';
import i18n, { setLocale } from '../../i18n/index.js';
import { LOCALE_STORAGE_KEY } from '../../i18n/locales.js';

type Action = 'exportChainPack' | 'publishToRegistry';
const PRIVATE = 'PRIVATE_metadata_82';
const NativeBlob = globalThis.Blob;
const descriptors = ['createObjectURL', 'revokeObjectURL'].map(key => Object.getOwnPropertyDescriptor(URL, key));
const initialLocale = i18n.language;
const initialStoredLocale = localStorage.getItem(LOCALE_STORAGE_KEY);
const unexpected: string[] = [];
let saved: ReturnType<typeof useBuilderStore.getState>;
let blobs: Blob[] = [];
let downloads: Array<{ name: string; href: string; connected: boolean }> = [];
let revoked: string[] = [];
let restoreAnchor = (): void => undefined;
let observer: MutationObserver | undefined;
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function record(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error('Expected JSON object');
  return v;
}

function content(v: unknown): Record<string, unknown> {
  const { createdAt: _created, updatedAt: _updated, ...rest } = record(v);
  return rest;
}
const stable = (): string => JSON.stringify(content(useBuilderStore.getState().snapshot()));
const counts = (): number[] => [blobs.length, downloads.length, revoked.length];
function noEffects(): void {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  expect(unexpected).toEqual([]);
}
function blobAt(index: number): Blob {
  const blob = blobs[index];
  if (!(blob instanceof NativeBlob)) throw new Error('Actual exported Blob missing');
  return blob;
}
async function jsonBlob(index: number): Promise<Record<string, unknown>> {
  const blob = blobAt(index);
  expect(blob.type).toBe('application/json');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Actual Blob read failed'));
    reader.onload = () => {
      try {
        if (typeof reader.result !== 'string') throw new Error('Expected actual Blob text');
        const value: unknown = JSON.parse(reader.result);
        resolve(record(value));
      } catch (error) { reject(error); }
    };
    reader.readAsText(blob);
  });
}
async function choose(key: Action | 'export'): Promise<void> {
  const trigger = screen.getByRole('button', { name: i18n.t('builder:workflowMenu') });
  fireEvent.click(trigger);
  const menu = screen.getByRole('menu', { name: i18n.t('builder:workflowMenu') });
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: i18n.t('builder:' + key) }));
  });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
}
beforeAll(async () => {
  const produced = await chainExportCatalog();
  expect(produced.nodes).toHaveLength(5);
  expect(produced.nodes).toContainEqual(expect.objectContaining({ typeId: 'core.noop', version: '1.4.2', source: 'pack', packName: 'fixture.chain-export.nodes' }));
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (typeof url !== 'string' || !url.endsWith('/host/openwop-app/node-catalog') || (init?.method ?? 'GET') !== 'GET') {
      unexpected.push(String(url)); throw new Error('Unexpected fixture transport');
    }
    return new Response(JSON.stringify({ nodes: produced.nodes }), { status: 200 });
  }));
  await loadDynamicCatalog();
  expect(isDynamicCatalogLoaded()).toBe(true);
  expect(catalogEntry('noop')).toBe(catalogEntryByTypeId('core.noop'));
  expect(catalogEntry('noop')?.version).toBe('1.4.2');
});
beforeEach(() => {
  saved = useBuilderStore.getState();
  for (const effect of Object.values(effects)) effect.mockClear();
  blobs = []; downloads = []; revoked = [];
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob | MediaSource): string => {
    if (!(blob instanceof NativeBlob)) throw new Error('Expected actual export Blob');
    blobs.push(blob); return 'blob:owned-' + blobs.length;
  } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string): void => { revoked.push(url); } });
  const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href, connected: this.isConnected });
  });
  restoreAnchor = () => { spy.mockRestore(); };
  useBuilderStore.setState({
    workflowId: 'wf-ui-export-82', name: 'UI export fixture',
    nodes: [{ id: 'a', kind: 'noop', name: 'Owned source', position: { x: 0, y: 0 },
      config: { keep: { falseValue: false, zero: 0, nil: null, text: 'Café 東京' } }, inputs: { text: 'owned input' } }], edges: [],
    defaultInputs: '{}', inputSchema: '', variables: [], configurableSchema: {},
    metadata: undefined, lifecycle: { transient: false }, overlay: null, debugSession: null,
    past: [], future: [], selectedNodeId: null, selectedNodeIds: [], selectedEdgeId: null,
    failureHeat: null, failureHeatMode: 'failures', syncState: 'pending',
  });
});
afterEach(async () => {
  observer?.disconnect(); observer = undefined;
  cleanup(); useBuilderStore.setState(saved, true); restoreAnchor();
  ['createObjectURL', 'revokeObjectURL'].forEach((key, index) => {
    const descriptor = descriptors[index];
    if (descriptor) Object.defineProperty(URL, key, descriptor); else Reflect.deleteProperty(URL, key);
  });
  noEffects(); await setLocale(initialLocale);
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (initialStoredLocale === null) localStorage.removeItem(LOCALE_STORAGE_KEY);
  else localStorage.setItem(LOCALE_STORAGE_KEY, initialStoredLocale);
});
async function mount(): Promise<void> {
  await act(async () => {
    render(<><GlobalLiveRegion /><MemoryRouter><BuilderShell onNewWorkflow={() => { throw new Error('Unexpected new workflow'); }} /></MemoryRouter></>);
  });
  expect(document.querySelectorAll('[data-owp-live="assertive"]')).toHaveLength(1);
}
it('admits real supported chain-download and publish-helper controls before refusal qualification', async () => {
  await setLocale('fr'); await i18n.loadNamespaces('builder');
  const before = stable(); await mount();
  await choose('exportChainPack');
  await waitFor(() => expect(counts()).toEqual([1, 1, 1]));
  expect(downloads).toEqual([{ name: 'ui-export-fixture.workflow-chain-pack.json', href: 'blob:owned-1', connected: true }]);
  const manifest = await jsonBlob(0);
  expect(manifest.kind).toBe('workflow-chain');
  expect(manifest.chains).toEqual([expect.objectContaining({
    chainId: 'community.local.ui-export-fixture', dag: expect.objectContaining({
      nodes: [expect.objectContaining({ id: 'a', typeId: 'core.noop@1.4.2', inputs: { text: 'owned input' } })],
    }),
  })]);
  await choose('publishToRegistry');
  const banner = await waitFor(() => {
    const value = document.querySelector('.alert--publish');
    if (!(value instanceof HTMLElement)) throw new Error('Actual helper missing');
    return value;
  });
  expect(within(banner).getByText(i18n.t('builder:publishHeading', { slug: 'ui-export-fixture' }))).toBeTruthy();
  expect(banner.querySelector('a[href="https://github.com/openwop/openwop"]')).not.toBeNull();
  expect(within(banner).getByRole('button', { name: i18n.t('builder:publishStepDownload') })).toBeTruthy();
  fireEvent.click(within(banner).getByRole('button', { name: i18n.t('common:close') }));
  expect(document.querySelector('.alert--publish')).toBeNull();
  expect(counts()).toEqual([1, 1, 1]); expect(stable()).toBe(before); noEffects();
});
async function exercise(action: Action): Promise<void> {
  await setLocale('fr'); await i18n.loadNamespaces('builder');
  const own: unknown = i18n.getResource('fr', 'builder', 'exportChainPackFidelity');
  if (typeof own !== 'string' || !own) throw new Error('Missing own French refusal resource');
  expect(i18n.t('builder:exportChainPackFidelity')).toBe(own);
  // Metadata alone is unsupported; supported controls have a dedicated case.
  act(() => useBuilderStore.setState({ metadata: { business: { keep: PRIVATE, falseValue: false, zero: 0, nil: null } } }));
  await mount();
  const before = stable();
  expect(counts()).toEqual([0, 0, 0]);
  const host = document.querySelector('[data-owp-live="assertive"]');
  if (!(host instanceof HTMLElement)) throw new Error('Actual pre-existing global host missing');
  const prior = host.textContent;
  const observed: string[] = [];
  observer = new MutationObserver(() => { observed.push(host.textContent ?? ''); });
  observer.observe(host, { subtree: true, childList: true, characterData: true });
  await choose(action);
  await waitFor(() => {
    const notice = screen.getByText(own, { selector: '.alert.error span' }).closest('.alert.error');
    if (!(notice instanceof HTMLElement)) throw new Error('Actual visible Notice missing');
    expect(notice.classList.contains('sr-only')).toBe(false);
    expect(notice.closest('[aria-hidden="true"]')).toBeNull();
    expect(getComputedStyle(notice).display).not.toBe('none');
    expect(getComputedStyle(notice).visibility).not.toBe('hidden');
    expect(notice.hasAttribute('role')).toBe(false);
    expect(notice.hasAttribute('aria-live')).toBe(false);
    expect(host.textContent).not.toBe(prior);
    expect((host.textContent ?? '').replace(/\u200b/g, '')).toBe(own);
    expect(observed.some(text => text.replace(/\u200b/g, '') === own)).toBe(true);
  });
  expect(own).not.toContain(PRIVATE); expect(host.textContent).not.toContain(PRIVATE);
  expect(counts()).toEqual([0, 0, 0]);
  expect(document.querySelector('.alert--publish')).toBeNull();
  expect(screen.queryByRole('button', { name: i18n.t('builder:publishStepDownload') })).toBeNull();
  expect(document.querySelectorAll('a[href^="https://github.com/openwop"]')).toHaveLength(0);
  expect(stable()).toBe(before); noEffects();

  await choose('export');
  expect(counts()).toEqual([1, 1, 1]);
  const actual = await jsonBlob(0);
  expect(content(actual)).toEqual(JSON.parse(before));
  expect(record(record(actual.metadata).business).keep).toBe(PRIVATE);
  expect(actual).toMatchObject({ createdAt: expect.any(String), updatedAt: expect.any(String) });
  expect(downloads.at(-1)).toEqual({ name: 'ui-export-fixture.openwop-workflow.json', href: 'blob:owned-' + blobs.length, connected: true });
  expect(revoked.at(-1)).toBe('blob:owned-' + blobs.length);
  expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  expect(document.querySelector('.alert--publish')).toBeNull();
  expect(stable()).toBe(before); noEffects();
}
it('actual Export chain pack refuses with French visible/global feedback and JSON recovery', async () => { await exercise('exportChainPack'); });
it('actual Publish helper refuses with French visible/global feedback and JSON recovery', async () => { await exercise('publishToRegistry'); });

it('retires a successful Publish helper when the current graph is refused', async () => {
  await setLocale('fr'); await i18n.loadNamespaces('builder');
  const own: unknown = i18n.getResource('fr', 'builder', 'exportChainPackFidelity');
  if (typeof own !== 'string' || !own) throw new Error('Missing own French refusal');
  await mount(); await choose('publishToRegistry');
  const banner = await waitFor(() => {
    const value = document.querySelector('.alert--publish');
    if (!(value instanceof HTMLElement)) throw new Error('Successful helper missing');
    return value;
  });
  expect(within(banner).getByRole('button', { name: i18n.t('builder:publishStepDownload') })).toBeTruthy();
  expect(banner.isConnected).toBe(true); expect(counts()).toEqual([0, 0, 0]);
  const metadata = { business: { keep: PRIVATE, falseValue: false, zero: 0, nil: null } };
  act(() => useBuilderStore.setState({ metadata }));
  expect(useBuilderStore.getState().metadata).toEqual(metadata);
  expect(banner.isConnected, 'Editing alone must retain the earlier helper').toBe(true);
  expect(document.querySelector('.alert--publish')).toBe(banner);
  const before = stable();
  const host = document.querySelector('[data-owp-live="assertive"]');
  if (!(host instanceof HTMLElement)) throw new Error('Actual global host missing');
  const prior = host.textContent;
  await choose('publishToRegistry');
  await waitFor(() => {
    const notice = screen.getByText(own, { selector: '.alert.error span' }).closest('.alert.error');
    if (!(notice instanceof HTMLElement)) throw new Error('Trusted refusal missing');
    expect(getComputedStyle(notice).display).not.toBe('none');
    expect(getComputedStyle(notice).visibility).not.toBe('hidden');
    expect(host.textContent).not.toBe(prior);
    expect((host.textContent ?? '').replace(/\u200b/g, '')).toBe(own);
  });
  expect(host.textContent).not.toContain(PRIVATE);
  expect(counts()).toEqual([0, 0, 0]); expect(stable()).toBe(before); noEffects();
  expect(banner.isConnected, 'Refused graph must retire the earlier helper').toBe(false);
  expect(document.querySelector('.alert--publish')).toBeNull();
});
