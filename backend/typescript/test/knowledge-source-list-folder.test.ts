/**
 * ADR 0107 Phase 1 — `listFolder` (knowledge-sync source diff input). The
 * SSRF-guarded broker (`brokeredFetch`) is mocked; this covers the Drive Files
 * list parsing, pagination, malformed-entry skipping, provider dispatch, and the
 * fail-closed mapping of a missing connection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/brokeredEgress.js', () => ({ brokeredFetch: vi.fn() }));
// The un-credentialed Graph downloadUrl fetch + its SSRF guard (ADR 0107 Phase: Graph binary).
vi.mock('undici', () => ({ fetch: vi.fn() }));
vi.mock('../src/host/webhookEgressGuard.js', () => ({
  isDeniedWebhookHost: vi.fn(() => false),
  webhookEgressDispatcher: vi.fn(() => ({})),
  webhookPrivateEgressAllowed: vi.fn(() => false),
}));
import { brokeredFetch } from '../src/host/brokeredEgress.js';
import { fetch as undiciFetch } from 'undici';
import { isDeniedWebhookHost } from '../src/host/webhookEgressGuard.js';
import { listFolder, fetchKnowledgeSource, fetchKnowledgeSourceBytes, browseFolders } from '../src/host/knowledgeSourceFetch.js';
import type { Storage } from '../src/storage/storage.js';

const mFetch = vi.mocked(brokeredFetch);
const mUndici = vi.mocked(undiciFetch);
const mDenied = vi.mocked(isDeniedWebhookHost);
const deps = { storage: {} as Storage, tenantId: 't1', actingUserId: 'user:a', orgId: 'org1' };
const sent = (body: unknown) => ({ outcome: 'sent' as const, res: { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response });
const sentBytes = (buf: Buffer) => ({ outcome: 'sent' as const, res: { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as unknown as Response });
const DRIVE_ID = '1AbcDEF_ghiJKL-mnoPQRstuVWxyz0123456789';

afterEach(() => mFetch.mockReset());

describe('listFolder (ADR 0107 Phase 1)', () => {
  it('parses Drive files into {fileId,name,mimeType,revision} and filters the folder', async () => {
    mFetch.mockResolvedValueOnce(sent({
      files: [
        { id: 'f1', name: 'Doc A', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-06-01T00:00:00Z' },
        { id: 'f2', name: 'Sheet B', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-06-02T00:00:00Z' },
      ],
    }) as never);
    const out = await listFolder(deps, 'google', 'FOLDER123');
    expect(out).toEqual([
      { fileId: 'f1', name: 'Doc A', mimeType: 'application/vnd.google-apps.document', revision: '2026-06-01T00:00:00Z' },
      { fileId: 'f2', name: 'Sheet B', mimeType: 'application/vnd.google-apps.spreadsheet', revision: '2026-06-02T00:00:00Z' },
    ]);
    // the query targets the folder + excludes trashed files
    const url = String(mFetch.mock.calls[0]![1].url);
    expect(decodeURIComponent(url)).toContain("'FOLDER123' in parents and trashed = false");
    expect(url).toContain('googleapis.com/drive/v3/files');
  });

  it('paginates via nextPageToken and merges pages', async () => {
    mFetch
      .mockResolvedValueOnce(sent({ files: [{ id: 'f1', name: 'A', mimeType: 'text/plain', modifiedTime: 'r1' }], nextPageToken: 'PAGE2' }) as never)
      .mockResolvedValueOnce(sent({ files: [{ id: 'f2', name: 'B', mimeType: 'text/plain', modifiedTime: 'r2' }] }) as never);
    const out = await listFolder(deps, 'google', 'F');
    expect(out.map((f) => f.fileId)).toEqual(['f1', 'f2']);
    expect(mFetch).toHaveBeenCalledTimes(2);
    expect(String(mFetch.mock.calls[1]![1].url)).toContain('pageToken=PAGE2');
  });

  it('skips malformed entries (missing id) and defaults a blank name', async () => {
    mFetch.mockResolvedValueOnce(sent({
      files: [{ name: 'no id' }, { id: 'f3', name: '', mimeType: 'text/plain', modifiedTime: 'r3' }],
    }) as never);
    const out = await listFolder(deps, 'google', 'F');
    expect(out).toEqual([{ fileId: 'f3', name: 'Untitled', mimeType: 'text/plain', revision: 'r3' }]);
  });

  it('rejects an unsupported provider', async () => {
    await expect(listFolder(deps, 'microsoft365', 'F')).rejects.toMatchObject({ code: 'validation_error' });
    expect(mFetch).not.toHaveBeenCalled();
  });

  it('fail-closes to credential_required when the connection is absent', async () => {
    mFetch.mockResolvedValueOnce({ outcome: 'no_connection' } as never);
    await expect(listFolder(deps, 'google', 'F')).rejects.toMatchObject({ code: 'credential_required' });
  });

  it('rejects a blank folder id', async () => {
    await expect(listFolder(deps, 'google', '   ')).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('rejects a folder id with query-injection characters (no Drive-query injection)', async () => {
    await expect(listFolder(deps, 'google', "F' or '1'='1")).rejects.toMatchObject({ code: 'validation_error' });
    await expect(listFolder(deps, 'google', 'F123/../other')).rejects.toMatchObject({ code: 'validation_error' });
    expect(mFetch).not.toHaveBeenCalled(); // rejected before any egress
  });

  // ── OneDrive / Microsoft Graph (Phase 6) ───────────────────────────────────

  it('lists a OneDrive folder — files only (skips subfolders), maps lastModifiedDateTime', async () => {
    mFetch.mockResolvedValueOnce(sent({
      value: [
        { id: 'i1', name: 'A.txt', file: { mimeType: 'text/plain' }, lastModifiedDateTime: '2026-06-01T00:00:00Z' },
        { id: 'sub', name: 'Sub', folder: { childCount: 2 } }, // a subfolder ⇒ skipped
        { id: 'i2', name: 'B.md', file: { mimeType: 'text/markdown' }, lastModifiedDateTime: '2026-06-02T00:00:00Z' },
      ],
    }) as never);
    const out = await listFolder(deps, 'microsoft-graph', 'FOLDER1');
    expect(out).toEqual([
      { fileId: 'i1', name: 'A.txt', mimeType: 'text/plain', revision: '2026-06-01T00:00:00Z' },
      { fileId: 'i2', name: 'B.md', mimeType: 'text/markdown', revision: '2026-06-02T00:00:00Z' },
    ]);
    const url = String(mFetch.mock.calls[0]![1].url);
    expect(url).toContain('graph.microsoft.com/v1.0/me/drive/items/FOLDER1/children');
  });

  it('OneDrive `root` targets /me/drive/root and follows @odata.nextLink', async () => {
    mFetch
      .mockResolvedValueOnce(sent({ value: [{ id: 'i1', name: 'A', file: { mimeType: 'text/plain' }, lastModifiedDateTime: 'r1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next?p=2' }) as never)
      .mockResolvedValueOnce(sent({ value: [{ id: 'i2', name: 'B', file: { mimeType: 'text/plain' }, lastModifiedDateTime: 'r2' }] }) as never);
    const out = await listFolder(deps, 'microsoft-graph', 'root');
    expect(out.map((f) => f.fileId)).toEqual(['i1', 'i2']);
    expect(String(mFetch.mock.calls[0]![1].url)).toContain('/me/drive/root/children');
    expect(String(mFetch.mock.calls[1]![1].url)).toBe('https://graph.microsoft.com/v1.0/next?p=2');
  });

  it('rejects a OneDrive folder id that could traverse the Graph path', async () => {
    await expect(listFolder(deps, 'microsoft-graph', 'a/b')).rejects.toMatchObject({ code: 'validation_error' });
    await expect(listFolder(deps, 'microsoft-graph', '..')).rejects.toMatchObject({ code: 'validation_error' });
    expect(mFetch).not.toHaveBeenCalled();
  });
});

describe('fetchKnowledgeSource — OneDrive (Phase 6)', () => {
  it('reads a text OneDrive item: meta then content → {title,text}', async () => {
    mFetch
      .mockResolvedValueOnce(sent({ name: 'notes.md', file: { mimeType: 'text/markdown' } }) as never) // meta
      .mockResolvedValueOnce({ outcome: 'sent', res: { ok: true, status: 200, text: async () => '# hi' } } as never); // content
    const out = await fetchKnowledgeSource(deps, { provider: 'microsoft-graph', ref: 'item1' });
    expect(out).toMatchObject({ title: 'notes.md', text: '# hi' });
    expect(String(mFetch.mock.calls[1]![1].url)).toContain('/me/drive/items/item1/content');
  });

  it('rejects a binary OneDrive item with no extractable text', async () => {
    mFetch.mockResolvedValueOnce(sent({ name: 'deck.pptx', file: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } }) as never);
    await expect(fetchKnowledgeSource(deps, { provider: 'microsoft-graph', ref: 'item2' })).rejects.toMatchObject({ code: 'validation_error' });
    expect(mFetch).toHaveBeenCalledTimes(1); // never fetched content
  });
});

describe('fetchKnowledgeSourceBytes (ADR 0107 Phase 2 — binary sync)', () => {
  afterEach(() => mFetch.mockReset());

  it('downloads a Google Drive file as bytes: meta then alt=media → {contentBase64,contentType}', async () => {
    mFetch
      .mockResolvedValueOnce(sent({ name: 'report.pdf', mimeType: 'application/pdf' }) as never) // meta
      .mockResolvedValueOnce(sentBytes(Buffer.from('PDFBYTES')) as never);                        // alt=media
    const out = await fetchKnowledgeSourceBytes(deps, { provider: 'google', ref: DRIVE_ID });
    expect(out.title).toBe('report.pdf');
    expect(out.contentType).toBe('application/pdf');
    expect(Buffer.from(out.contentBase64, 'base64').toString()).toBe('PDFBYTES');
    expect(String(mFetch.mock.calls[1]![1].url)).toContain('alt=media'); // content via alt=media
  });

  it('REJECTS an oversize download (413) — never truncates a binary into corruption', async () => {
    mFetch
      .mockResolvedValueOnce(sent({ name: 'huge.pdf', mimeType: 'application/pdf' }) as never)
      .mockResolvedValueOnce(sentBytes(Buffer.alloc(33 * 1024 * 1024)) as never); // > 32 MiB
    await expect(fetchKnowledgeSourceBytes(deps, { provider: 'google', ref: DRIVE_ID }))
      .rejects.toMatchObject({ httpStatus: 413 });
  });

  it('downloads a OneDrive file via @microsoft.graph.downloadUrl (SSRF-guarded, un-credentialed)', async () => {
    mFetch.mockReset(); mUndici.mockReset(); mDenied.mockReset(); mDenied.mockReturnValue(false);
    // meta (credentialed, graph.microsoft.com) carries the pre-auth download URL
    mFetch.mockResolvedValueOnce(sent({ name: 'deck.pptx', file: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }, '@microsoft.graph.downloadUrl': 'https://abc-my.sharepoint.com/download/xyz' }) as never);
    // the downloadUrl fetch is un-credentialed (undici), returns bytes
    const pptx = Buffer.from('PPTXBYTES');
    mUndici.mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => pptx.buffer.slice(pptx.byteOffset, pptx.byteOffset + pptx.byteLength) } as never);
    const out = await fetchKnowledgeSourceBytes(deps, { provider: 'microsoft-graph', ref: 'item1' });
    expect(out.contentType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(Buffer.from(out.contentBase64, 'base64').toString()).toBe('PPTXBYTES');
    // the download host was SSRF-checked, and the fetch went un-credentialed via undici
    expect(mDenied).toHaveBeenCalledWith('abc-my.sharepoint.com');
    expect(String(mUndici.mock.calls[0]![0])).toBe('https://abc-my.sharepoint.com/download/xyz');
  });

  it('rejects a download host that the SSRF guard denies (private IP) — 502', async () => {
    mFetch.mockReset(); mUndici.mockReset(); mDenied.mockReset();
    mFetch.mockResolvedValueOnce(sent({ name: 'x', file: { mimeType: 'application/pdf' }, '@microsoft.graph.downloadUrl': 'https://169.254.169.254/latest/meta-data' }) as never);
    mDenied.mockReturnValue(true); // guard denies the metadata-service host
    await expect(fetchKnowledgeSourceBytes(deps, { provider: 'microsoft-graph', ref: 'item1' }))
      .rejects.toMatchObject({ httpStatus: 502 });
    expect(mUndici).not.toHaveBeenCalled(); // never fetched the denied host
  });

  it('rejects a OneDrive item with no download URL (422 — folder or access denied)', async () => {
    mFetch.mockReset(); mUndici.mockReset(); mDenied.mockReturnValue(false);
    mFetch.mockResolvedValueOnce(sent({ name: 'x', file: { mimeType: 'application/pdf' } }) as never); // no downloadUrl
    await expect(fetchKnowledgeSourceBytes(deps, { provider: 'microsoft-graph', ref: 'item1' }))
      .rejects.toMatchObject({ httpStatus: 422 });
  });
});

describe('listFolder — Google excludes subfolders (no recursion)', () => {
  afterEach(() => mFetch.mockReset());
  it('the Drive query filters out folders', async () => {
    mFetch.mockResolvedValueOnce(sent({ files: [] }) as never);
    await listFolder(deps, 'google', 'FOLDER1');
    const url = decodeURIComponent(String(mFetch.mock.calls[0]![1].url));
    expect(url).toContain("mimeType != 'application/vnd.google-apps.folder'");
  });
});

describe('Dropbox (ADR 0107 follow-on)', () => {
  afterEach(() => { mFetch.mockReset(); mUndici.mockReset(); mDenied.mockReset(); mDenied.mockReturnValue(false); });

  it('lists a Dropbox folder — files only, infers MIME from name, rev as revision', async () => {
    mFetch.mockResolvedValueOnce(sent({
      entries: [
        { '.tag': 'file', id: 'id:1', name: 'report.pdf', rev: 'r1' },
        { '.tag': 'folder', id: 'id:sub', name: 'Sub' }, // a folder ⇒ skipped
        { '.tag': 'file', id: 'id:2', name: 'deck.pptx', rev: 'r2' },
      ],
      has_more: false,
    }) as never);
    const out = await listFolder(deps, 'dropbox', '/Reports');
    expect(out).toEqual([
      { fileId: 'id:1', name: 'report.pdf', mimeType: 'application/pdf', revision: 'r1' },
      { fileId: 'id:2', name: 'deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', revision: 'r2' },
    ]);
    // the folder ref rides the JSON BODY (no URL-injection surface)
    expect(String(mFetch.mock.calls[0]![1].url)).toContain('api.dropboxapi.com/2/files/list_folder');
    expect(mFetch.mock.calls[0]![1].method).toBe('POST');
    expect(JSON.parse(String(mFetch.mock.calls[0]![1].body)).path).toBe('/Reports');
  });

  it('paginates via list_folder/continue with the cursor', async () => {
    mFetch
      .mockResolvedValueOnce(sent({ entries: [{ '.tag': 'file', id: 'id:1', name: 'a.txt', rev: 'r1' }], has_more: true, cursor: 'CUR2' }) as never)
      .mockResolvedValueOnce(sent({ entries: [{ '.tag': 'file', id: 'id:2', name: 'b.txt', rev: 'r2' }], has_more: false }) as never);
    const out = await listFolder(deps, 'dropbox', 'root');
    expect(out.map((f) => f.fileId)).toEqual(['id:1', 'id:2']);
    expect(String(mFetch.mock.calls[1]![1].url)).toContain('/2/files/list_folder/continue');
    expect(JSON.parse(String(mFetch.mock.calls[1]![1].body)).cursor).toBe('CUR2');
  });

  it('downloads a Dropbox file via get_temporary_link → un-credentialed SSRF-guarded fetch', async () => {
    mFetch.mockResolvedValueOnce(sent({ link: 'https://dl.dropboxusercontent.com/abc', metadata: { name: 'report.pdf' } }) as never);
    const pdf = Buffer.from('PDFBYTES');
    mUndici.mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) } as never);
    const out = await fetchKnowledgeSourceBytes(deps, { provider: 'dropbox', ref: 'id:1' });
    expect(out.contentType).toBe('application/pdf');
    expect(Buffer.from(out.contentBase64, 'base64').toString()).toBe('PDFBYTES');
    expect(mDenied).toHaveBeenCalledWith('dl.dropboxusercontent.com'); // SSRF-checked
    expect(String(mFetch.mock.calls[0]![1].url)).toContain('/2/files/get_temporary_link');
  });

  it('rejects a Dropbox download whose temp-link host is SSRF-denied (502)', async () => {
    mFetch.mockResolvedValueOnce(sent({ link: 'https://169.254.169.254/x', metadata: { name: 'a.pdf' } }) as never);
    mDenied.mockReturnValue(true);
    await expect(fetchKnowledgeSourceBytes(deps, { provider: 'dropbox', ref: 'id:1' })).rejects.toMatchObject({ httpStatus: 502 });
    expect(mUndici).not.toHaveBeenCalled();
  });
});

describe('Box (ADR 0107 follow-on)', () => {
  const sentRedirect = (location: string) => ({ outcome: 'sent' as const, res: { ok: false, status: 302, headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location : null) } } as unknown as Response });
  afterEach(() => { mFetch.mockReset(); mUndici.mockReset(); mDenied.mockReset(); mDenied.mockReturnValue(false); });

  it('lists a Box folder — files only, etag as revision, MIME from name; root ⇒ folder 0', async () => {
    mFetch.mockResolvedValueOnce(sent({
      entries: [
        { type: 'file', id: '11', name: 'report.pdf', etag: '3' },
        { type: 'folder', id: '22', name: 'Sub' }, // skipped
        { type: 'file', id: '33', name: 'sheet.xlsx', etag: '7' },
      ],
      total_count: 3,
    }) as never);
    const out = await listFolder(deps, 'box', 'root');
    expect(out).toEqual([
      { fileId: '11', name: 'report.pdf', mimeType: 'application/pdf', revision: '3' },
      { fileId: '33', name: 'sheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', revision: '7' },
    ]);
    expect(String(mFetch.mock.calls[0]![1].url)).toContain('api.box.com/2.0/folders/0/items');
  });

  it('downloads a Box file: meta name + a redirect:manual 302 → Location → un-credentialed fetch', async () => {
    mFetch
      .mockResolvedValueOnce(sent({ name: 'report.pdf' }) as never)                 // meta
      .mockResolvedValueOnce(sentRedirect('https://dl.boxcloud.com/abc') as never); // content 302
    const pdf = Buffer.from('BOXPDF');
    mUndici.mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) } as never);
    const out = await fetchKnowledgeSourceBytes(deps, { provider: 'box', ref: '11' });
    expect(out.contentType).toBe('application/pdf');
    expect(Buffer.from(out.contentBase64, 'base64').toString()).toBe('BOXPDF');
    // the content call used redirect:'manual' (token stays on api.box.com), then SSRF-checked the download host
    expect(mFetch.mock.calls[1]![1].redirect).toBe('manual');
    expect(mDenied).toHaveBeenCalledWith('dl.boxcloud.com');
  });

  it('rejects when the Box download Location is SSRF-denied (502)', async () => {
    mFetch
      .mockResolvedValueOnce(sent({ name: 'a.pdf' }) as never)
      .mockResolvedValueOnce(sentRedirect('https://169.254.169.254/x') as never);
    mDenied.mockReturnValue(true);
    await expect(fetchKnowledgeSourceBytes(deps, { provider: 'box', ref: '11' })).rejects.toMatchObject({ httpStatus: 502 });
    expect(mUndici).not.toHaveBeenCalled();
  });

  it('rejects a Box id with path-traversal characters', async () => {
    await expect(listFolder(deps, 'box', '0/../1')).rejects.toMatchObject({ code: 'validation_error' });
    expect(mFetch).not.toHaveBeenCalled();
  });
});

describe('browseFolders — subfolders for the picker (ADR 0107 follow-on)', () => {
  afterEach(() => mFetch.mockReset());

  it('Google: folder-filtered query, returns {id,name}', async () => {
    mFetch.mockResolvedValueOnce(sent({ files: [{ id: 'fa', name: 'Reports' }, { id: 'fb', name: 'Decks' }] }) as never);
    const out = await browseFolders(deps, 'google', 'root');
    expect(out).toEqual([{ id: 'fa', name: 'Reports' }, { id: 'fb', name: 'Decks' }]);
    expect(decodeURIComponent(String(mFetch.mock.calls[0]![1].url))).toContain("mimeType = 'application/vnd.google-apps.folder'");
  });

  it('OneDrive: keeps only folder-facet children', async () => {
    mFetch.mockResolvedValueOnce(sent({ value: [
      { id: 'd1', name: 'Library', folder: { childCount: 3 } },
      { id: 'f1', name: 'a.pdf', file: { mimeType: 'application/pdf' } }, // a file ⇒ skipped
    ] }) as never);
    const out = await browseFolders(deps, 'microsoft-graph', 'root');
    expect(out).toEqual([{ id: 'd1', name: 'Library' }]);
  });

  it('Box: keeps type==folder, root ⇒ folder 0', async () => {
    mFetch.mockResolvedValueOnce(sent({ entries: [
      { type: 'folder', id: '9', name: 'Shared' },
      { type: 'file', id: '8', name: 'x.pdf' },
    ], total_count: 2 }) as never);
    const out = await browseFolders(deps, 'box', 'root');
    expect(out).toEqual([{ id: '9', name: 'Shared' }]);
    expect(String(mFetch.mock.calls[0]![1].url)).toContain('/2.0/folders/0/items');
  });

  it('Dropbox: keeps .tag==folder', async () => {
    mFetch.mockResolvedValueOnce(sent({ entries: [
      { '.tag': 'folder', id: 'id:f', name: 'Team' },
      { '.tag': 'file', id: 'id:x', name: 'y.pdf' },
    ], has_more: false }) as never);
    const out = await browseFolders(deps, 'dropbox', 'root');
    expect(out).toEqual([{ id: 'id:f', name: 'Team' }]);
  });

  it('rejects browsing an unsupported provider (SharePoint deferred)', async () => {
    await expect(browseFolders(deps, 'microsoft-sharepoint', 'x')).rejects.toMatchObject({ code: 'validation_error' });
  });
});
