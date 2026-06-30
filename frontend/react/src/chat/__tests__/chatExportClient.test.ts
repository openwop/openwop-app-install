/**
 * ADR 0119 Phase 5 — exportConversation fetches the export route + triggers a download.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { exportConversation, importConversation, detectImportFormat } from '../../client/chatExportClient.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('exportConversation', () => {
  it('GETs the export route with the format + downloads the blob', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '# Transcript' } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    const click = vi.fn();
    vi.spyOn(document, 'createElement').mockReturnValue({ click, remove: vi.fn(), href: '', download: '' } as unknown as HTMLAnchorElement);
    vi.spyOn(document.body, 'appendChild').mockImplementation((n) => n);

    await exportConversation('sess-1', 'md');

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/chat-export/sess-1');
    expect(url).toContain('format=md');
    expect(click).toHaveBeenCalled(); // download triggered
  });

  it('throws on a non-OK response (so the caller can surface it)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 } as unknown as Response)));
    await expect(exportConversation('nope', 'json')).rejects.toThrow(/export_failed_404/);
  });
});

describe('detectImportFormat', () => {
  it('detects openwop vs chatgpt', () => {
    expect(detectImportFormat({ version: 'openwop-v1', messages: [] })).toBe('openwop');
    expect(detectImportFormat({ mapping: { a: {} }, current_node: 'a' })).toBe('chatgpt');
    expect(detectImportFormat(null)).toBe('openwop');
  });
});

describe('importConversation', () => {
  it('POSTs {format, data} to the import route + returns the new session', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ sessionId: 's2', imported: 3 }) } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);
    const out = await importConversation('openwop', { version: 'openwop-v1' });
    expect(out).toEqual({ sessionId: 's2', imported: 3 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/chat-export/import');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ format: 'openwop' });
  });
  it('throws on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400 } as unknown as Response)));
    await expect(importConversation('openwop', {})).rejects.toThrow(/import_failed_400/);
  });
});
