/**
 * ADR 1158 — `directHostSelectionHeaders`, the one place a direct-host request gets
 * the active workspace's selection token.
 *
 * Pinned: the token from `/me/workspaces` becomes the header; it is cached until a
 * minute before the token's own expiry and re-read after; an auth change (a workspace
 * switch is one) drops the cache; no read at all without a bearer or when the direct
 * base is the API's own host. It fails CLOSED: a failed read, or one that straddled an
 * auth change, rejects with `WorkspaceSelectionUnavailableError` (sending the request
 * without the header would read the personal workspace), and a failed read starts a
 * cool-down of 2 s doubling to 60 s during which it rejects without reading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  authorization: 'Bearer id-token' as string | undefined,
  sseBaseUrl: 'https://backend.example.run.app',
  authListeners: [] as Array<() => void>,
}));
vi.mock('../config.js', () => ({
  config: { get baseUrl() { return '/api'; }, get sseBaseUrl() { return env.sseBaseUrl; } },
  authedHeaders: () => (env.authorization ? { authorization: env.authorization } : {}),
  onAuthChange: (fn: () => void) => { env.authListeners.push(fn); return () => undefined; },
}));
const list = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../workspaceClient.js', () => ({
  WORKSPACE_SELECTION_HEADER: 'x-openwop-workspace-selection',
  listMyWorkspaces: (...args: unknown[]) => list.fn(...args),
}));

import { directHostSelectionHeaders, resetDirectHostSelectionForTests, WorkspaceSelectionUnavailableError } from '../directHostSelection.js';

const SEL = 'x-openwop-workspace-selection';
const NOW = 1_800_000_000_000;
/** A token whose third field is its expiry in seconds, as the host mints it. */
const token = (expSec: number): string => `ws1.d3M6cWE.${expSec}.sig`;

beforeEach(() => {
  env.authorization = 'Bearer id-token';
  env.sseBaseUrl = 'https://backend.example.run.app';
  list.fn.mockReset();
  resetDirectHostSelectionForTests();
});
afterEach(() => vi.restoreAllMocks());

describe('directHostSelectionHeaders', () => {
  it('sends the token the workspace list returned, read without remembering the tenant', async () => {
    list.fn.mockResolvedValue({ selectionToken: token(NOW / 1000 + 600) });
    expect(await directHostSelectionHeaders(NOW)).toEqual({ [SEL]: token(NOW / 1000 + 600) });
    expect(list.fn).toHaveBeenCalledWith({ rememberTenant: false });
  });

  it('caches until a minute before the token expires, then re-reads', async () => {
    list.fn.mockResolvedValue({ selectionToken: token(NOW / 1000 + 600) });
    await directHostSelectionHeaders(NOW);
    await directHostSelectionHeaders(NOW + 539_000);
    expect(list.fn).toHaveBeenCalledTimes(1);
    await directHostSelectionHeaders(NOW + 540_000);
    expect(list.fn).toHaveBeenCalledTimes(2);
  });

  it('shares one read between concurrent callers', async () => {
    list.fn.mockResolvedValue({ selectionToken: token(NOW / 1000 + 600) });
    await Promise.all([directHostSelectionHeaders(NOW), directHostSelectionHeaders(NOW)]);
    expect(list.fn).toHaveBeenCalledTimes(1);
  });

  it('an auth change drops the cache', async () => {
    list.fn.mockResolvedValue({ selectionToken: token(NOW / 1000 + 600) });
    await directHostSelectionHeaders(NOW);
    for (const fn of env.authListeners) fn();
    await directHostSelectionHeaders(NOW);
    expect(list.fn).toHaveBeenCalledTimes(2);
  });

  it('a read that straddled an auth change rejects instead of sending the old selection', async () => {
    let release: (v: unknown) => void = () => undefined;
    list.fn.mockReturnValue(new Promise((r) => { release = r; }));
    const pending = directHostSelectionHeaders(NOW);
    await vi.waitFor(() => expect(list.fn).toHaveBeenCalledTimes(1));
    for (const fn of env.authListeners) fn();
    release({ selectionToken: token(NOW / 1000 + 600) });
    await expect(pending).rejects.toBeInstanceOf(WorkspaceSelectionUnavailableError);
  });

  it('no shared workspace ⇒ no header, and no re-read for five minutes', async () => {
    list.fn.mockResolvedValue({});
    expect(await directHostSelectionHeaders(NOW)).toEqual({});
    await directHostSelectionHeaders(NOW + 299_000);
    expect(list.fn).toHaveBeenCalledTimes(1);
  });

  it('no bearer ⇒ no read and no header', async () => {
    env.authorization = undefined;
    expect(await directHostSelectionHeaders(NOW)).toEqual({});
    expect(list.fn).not.toHaveBeenCalled();
  });

  it('a direct base on the API host ⇒ no read (the cookie already travels)', async () => {
    env.sseBaseUrl = '/api';
    expect(await directHostSelectionHeaders(NOW)).toEqual({});
    expect(list.fn).not.toHaveBeenCalled();
  });

  it('a failed read rejects with the typed error, in plain words', async () => {
    list.fn.mockRejectedValue(new Error('listMyWorkspaces returned 503'));
    const err = await directHostSelectionHeaders(NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceSelectionUnavailableError);
    expect((err as Error).message).toBe('The active workspace could not be confirmed. Retrying.');
  });

  it('a later successful read recovers', async () => {
    list.fn.mockRejectedValueOnce(new Error('503')).mockResolvedValue({ selectionToken: token(NOW / 1000 + 600) });
    await expect(directHostSelectionHeaders(NOW)).rejects.toBeInstanceOf(WorkspaceSelectionUnavailableError);
    expect(await directHostSelectionHeaders(NOW + 2_000)).toEqual({ [SEL]: token(NOW / 1000 + 600) });
  });

  it('after a failure it rejects without reading for 2 s, then 4 s, doubling', async () => {
    list.fn.mockRejectedValue(new Error('503'));
    await expect(directHostSelectionHeaders(NOW)).rejects.toThrow();
    await expect(directHostSelectionHeaders(NOW + 1_999)).rejects.toBeInstanceOf(WorkspaceSelectionUnavailableError);
    expect(list.fn).toHaveBeenCalledTimes(1);
    await expect(directHostSelectionHeaders(NOW + 2_000)).rejects.toThrow();
    expect(list.fn).toHaveBeenCalledTimes(2);
    await expect(directHostSelectionHeaders(NOW + 5_999)).rejects.toThrow();
    expect(list.fn).toHaveBeenCalledTimes(2);
    await expect(directHostSelectionHeaders(NOW + 6_000)).rejects.toThrow();
    expect(list.fn).toHaveBeenCalledTimes(3);
  });

  it('the cool-down caps at 60 s', async () => {
    list.fn.mockRejectedValue(new Error('503'));
    let t = NOW;
    for (let i = 0; i < 8; i++) {
      await expect(directHostSelectionHeaders(t)).rejects.toThrow();
      t += Math.min(2_000 * 2 ** i, 60_000);
    }
    // t is when the 8th cool-down ends: the 9th read happens, and its cool-down is the cap.
    expect(list.fn).toHaveBeenCalledTimes(8);
    await expect(directHostSelectionHeaders(t)).rejects.toThrow();
    expect(list.fn).toHaveBeenCalledTimes(9);
    await expect(directHostSelectionHeaders(t + 59_999)).rejects.toThrow();
    expect(list.fn).toHaveBeenCalledTimes(9);
    await expect(directHostSelectionHeaders(t + 60_000)).rejects.toThrow();
    expect(list.fn).toHaveBeenCalledTimes(10);
  });

  it('an auth change ends the cool-down', async () => {
    list.fn.mockRejectedValueOnce(new Error('503')).mockResolvedValue({});
    await expect(directHostSelectionHeaders(NOW)).rejects.toThrow();
    for (const fn of env.authListeners) fn();
    expect(await directHostSelectionHeaders(NOW + 1)).toEqual({});
    expect(list.fn).toHaveBeenCalledTimes(2);
  });
});
