/**
 * ADR 0119 Phase 5 — exportConversation fetches the export route + triggers a
 * named download; importConversation POSTs {format, data}. Breaks if the wrong
 * route / format / session is fetched (incl. an unencoded session id), the
 * download is not triggered, named or cleaned up, the import body loses `data`,
 * or a non-OK response resolves silently instead of throwing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { exportConversation, importConversation, detectImportFormat } from '../../client/chatExportClient.js';
import { config } from '../../client/config.js';

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

describe('exportConversation', () => {
  it('GETs the export route with the format + downloads the blob', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('# Transcript', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn<typeof URL.createObjectURL>(() => 'blob:x');
    const revokeObjectURL = vi.fn<typeof URL.revokeObjectURL>();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const clicked: Array<{ href: string; download: string; attached: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, attached: document.body.contains(this) });
    });

    await exportConversation('sess 1/x', 'md');

    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${config.baseUrl}/host/openwop-app/chat-export/sess%201%2Fx?format=md`);
    // Download triggered once, from an attached anchor, with the blob url and the named file.
    expect(clicked).toEqual([{ href: 'blob:x', download: 'conversation-sess 1/x.md', attached: true }]);
    const blob = createObjectURL.mock.calls[0]![0];
    if (!(blob instanceof Blob)) throw new Error('createObjectURL was not given a Blob');
    expect(blob.type).toBe('text/markdown');
    // Cleaned up: the object url is revoked and the anchor removed.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
    expect(document.body.querySelector('a[download]')).toBeNull();
  });

  it('throws on a non-OK response (so the caller can surface it)', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })));
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
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ sessionId: 's2', imported: 3 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await importConversation('openwop', { version: 'openwop-v1' });
    expect(out).toEqual({ sessionId: 's2', imported: 3 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${config.baseUrl}/host/openwop-app/chat-export/import`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ format: 'openwop', data: { version: 'openwop-v1' } });
  });
  it('throws on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 400 })));
    await expect(importConversation('openwop', {})).rejects.toThrow(/import_failed_400/);
  });
});
