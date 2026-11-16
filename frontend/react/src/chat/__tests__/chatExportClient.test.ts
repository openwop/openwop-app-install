/**
 * ADR 0119 Phase 5 — exportConversation fetches the export route + triggers a
 * named download; importConversation POSTs {format, data}. Breaks if the wrong
 * route / format / session is fetched (incl. an unencoded session id), the
 * download is not triggered, named or cleaned up, the import body loses `data`,
 * or a non-OK response resolves silently instead of throwing.
 *
 * ADR 0992 D9: the file is named by the server's Content-Disposition (a UUID or a
 * hostile header never becomes the name); an import failure is TYPED so the chat can
 * say why; a ChatGPT archive is recognised and listed; the idempotency key rides the body.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  exportConversation, importConversation, detectImportFormat, isChatGptArchive, listArchiveConversations,
  fileNameFromDisposition, fileDigest, ChatImportError, type ImportResult,
} from '../../client/chatExportClient.js';
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
    // ADR 0992 D9 — no Content-Disposition → a neutral name, never the session id.
    expect(clicked).toEqual([{ href: 'blob:x', download: 'conversation.md', attached: true }]);
    const blob = createObjectURL.mock.calls[0]![0];
    if (!(blob instanceof Blob)) throw new Error('createObjectURL was not given a Blob');
    expect(blob.type).toBe('text/markdown');
    // Cleaned up: the object url is revoked and the anchor removed.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
    expect(document.body.querySelector('a[download]')).toBeNull();
  });

  it('names the download from the server (Content-Disposition); refuses an unsafe name', async () => {
    expect(fileNameFromDisposition('attachment; filename="launch-plan.md"')).toBe('launch-plan.md');
    expect(fileNameFromDisposition('attachment; filename="../../etc/passwd"')).toBeNull();
    expect(fileNameFromDisposition(null)).toBeNull();
    // …and the export actually USES it: the server's name becomes the download name.
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"version":"openwop-v1"}', {
      status: 200, headers: { 'content-disposition': 'attachment; filename="launch-plan.json"' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn<typeof URL.createObjectURL>(() => 'blob:y');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn<typeof URL.revokeObjectURL>();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    await exportConversation('s-9', 'json');
    expect(names).toEqual(['launch-plan.json']);
    const blob = createObjectURL.mock.calls[0]![0];
    if (!(blob instanceof Blob)) throw new Error('createObjectURL was not given a Blob');
    expect(blob.type).toBe('application/json');
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
    const result: ImportResult = { sessionId: 's2', imported: 3, skipped: 1, truncated: 0, replayed: false };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(result), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await importConversation('openwop', { version: 'openwop-v1' });
    expect(out).toEqual({ sessionId: 's2', imported: 3, skipped: 1, truncated: 0, replayed: false });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${config.baseUrl}/host/openwop-app/chat-export/import`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ format: 'openwop', data: { version: 'openwop-v1' } });
  });
  it('ADR 0992 D4 — sends the idempotency key when given', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await importConversation('chatgpt', { mapping: {} }, 'abc:3');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ idempotencyKey: 'abc:3' });
  });
  it.each([
    [413, null, 'too_large'],
    [409, { error: 'conflict', details: { reason: 'import_conflict' } }, 'conflict'],
    [400, { error: 'validation_error', details: { reason: 'empty' } }, 'empty'],
    [400, { error: 'validation_error', details: { reason: 'not_openwop' } }, 'unsupported'],
    [500, null, 'failed'],
  ] as const)('ADR 0992 D9 — a %i (%j) is a typed %s failure', async (status, body, failure) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(body ? JSON.stringify(body) : null, { status })));
    const err = await importConversation('openwop', {}).catch((e: unknown) => e);
    if (!(err instanceof ChatImportError)) throw new Error(`expected a ChatImportError, got ${String(err)}`);
    expect(err.failure).toBe(failure);
    expect(err.status).toBe(status);
  });
});

describe('ADR 0992 D9 — ChatGPT archives', () => {
  const archive = [
    { title: 'Older', create_time: 1_600_000_000, mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['hi'] } } }, b: { message: null } } },
    { title: '', create_time: 1_700_000_000, mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['x'] } } }, b: { message: { author: { role: 'assistant' }, content: { parts: ['', 'y'] } } } } },
  ];
  it('recognises an archive (an array of conversation trees), not a single export', () => {
    expect(isChatGptArchive(archive)).toBe(true);
    expect(isChatGptArchive(archive[0])).toBe(false);
    expect(isChatGptArchive([])).toBe(false);
    expect(isChatGptArchive([{ version: 'openwop-v1' }])).toBe(false);
  });
  it('counts only the user/assistant turns the server will store (grade-ux CX2UX-4)', () => {
    const [entry] = listArchiveConversations([{ mapping: {
      a: { message: { author: { role: 'system' }, content: { parts: ['sys'] } } },
      b: { message: { author: { role: 'tool' }, content: { parts: ['tool out'] } } },
      c: { message: { author: { role: 'user' }, content: { parts: ['q'] } } },
      // A whitespace-only reply stores nothing, so it is not counted either.
      d: { message: { author: { role: 'assistant' }, content: { parts: ['  ', ''] } } },
    } }]);
    expect(entry!.messageCount).toBe(1);
  });
  it('lists conversations newest first, keeping each one\'s index into the file', () => {
    const entries = listArchiveConversations(archive);
    expect(entries.map((e) => e.index)).toEqual([1, 0]);
    expect(entries[0]).toMatchObject({ title: '', messageCount: 2 });
    expect(entries[0]).toMatchObject({ createdAt: '2023-11-14T22:13:20.000Z' });
    expect(entries[1]).toMatchObject({ title: 'Older', messageCount: 1, createdAt: '2020-09-13T12:26:40.000Z' });
  });
  it('digests the file deterministically for the idempotency key', async () => {
    const a = await fileDigest('same');
    // SHA-256 of "same", computed outside the subject (`printf same | shasum -a 256`).
    expect(a).toBe('0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5');
    expect(await fileDigest('same')).toBe(a);
    expect(await fileDigest('other')).not.toBe(a);
  });
});
