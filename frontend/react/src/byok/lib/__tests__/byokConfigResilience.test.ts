/**
 * ADR 0517 — the state machine that decides whether to ASK THE USER FOR A KEY.
 *
 * Every case below is a way the old hook wrongly concluded "this user has no API
 * key" and opened a wizard that then minted a duplicate secret. The reported
 * workspace ended up with seven `byok:google:*` rows this way. The invariant these
 * lock in: the surface only reaches `needs-key` when the workspace GENUINELY has
 * nothing to bind — never because a request failed, never because a session
 * lapsed, and never while a usable key is sitting in the store.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { StrictMode, createElement } from 'react';

const getActiveConfig = vi.fn();
const putActiveConfig = vi.fn();
const clearActiveConfig = vi.fn();
const listStoredRefs = vi.fn();

// ADR 0517 Phase E — the hook now refuses to conclude anything until the auth layer has
// SETTLED, so every test must declare an identity. That is the point: reading
// during the boot window is what let a returning user be told their session had
// ended a beat before it was silently restored.
let subject: { status: 'pending' } | { status: 'anonymous' } | { status: 'user'; subject: string } = { status: 'anonymous' };
vi.mock('../../../platform/useStorageSubject.js', () => ({ useStorageSubject: () => subject }));

vi.mock('../byokClient.js', () => ({
  getActiveConfig: (...a: unknown[]) => getActiveConfig(...a),
  putActiveConfig: (...a: unknown[]) => putActiveConfig(...a),
  clearActiveConfig: (...a: unknown[]) => clearActiveConfig(...a),
  listStoredRefs: (...a: unknown[]) => listStoredRefs(...a),
}));

const { useBYOKConfig, preferredRefForProvider, refsForProvider } = await import('../useBYOKConfig.js');

const LS_KEY = 'openwop-app.byok.activeConfig';
const GOOGLE = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' };

/** An envelope with no binding — the shape every false prompt started from. */
const empty = (anonymous = false) => ({ config: null, valid: false, anonymous });

/** StrictMode invokes the mount effect twice, so two reads are expected WITHOUT a
 *  retry. Anything beyond that is the grace retry actually firing. */
const reAuthBaselineCalls = 2;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  subject = { status: 'anonymous' };
  putActiveConfig.mockImplementation(async (cfg: unknown) => ({ config: cfg, valid: true, anonymous: false }));
  clearActiveConfig.mockResolvedValue(undefined);
});
afterEach(() => { vi.clearAllMocks(); });

describe('ADR 0517 — a server-vouched binding just works', () => {
  it('renders ready and caches the binding for first paint next time', async () => {
    getActiveConfig.mockResolvedValue({ config: GOOGLE, valid: true, anonymous: false });
    listStoredRefs.mockResolvedValue(['byok:google']);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.config).toMatchObject(GOOGLE);
    expect(JSON.parse(localStorage.getItem(LS_KEY)!)).toMatchObject(GOOGLE);
  });
});

describe('ADR 0517 — a failure is never evidence that the key is gone', () => {
  it('reports `error`, NOT `needs-key`, when the backend is unreachable', async () => {
    // The old hook inferred validity from a ref list, so a failed or empty list
    // read as "no key" and opened the wizard. An outage must never cost the user
    // their key entry.
    getActiveConfig.mockRejectedValue(new Error('network down'));
    listStoredRefs.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.status).not.toBe('needs-key');
    expect(result.current.error).toMatch(/network down/);
  });

  it('a BACKGROUND refresh failure does not disturb a working chat', async () => {
    getActiveConfig.mockResolvedValue({ config: GOOGLE, valid: true, anonymous: false });
    listStoredRefs.mockResolvedValue(['byok:google']);
    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // The tab-visibility re-sync fires and the request blips.
    getActiveConfig.mockRejectedValue(new Error('blip'));
    listStoredRefs.mockRejectedValue(new Error('blip'));
    await act(async () => { await result.current.refresh({ background: true }); });

    expect(result.current.status).toBe('ready');
    expect(result.current.config).toMatchObject(GOOGLE);
    // And it stays SILENT. A tab-return blip that surfaces an error banner over a
    // working chat is the same class of dishonesty as the wizard: reporting a
    // problem the user does not have.
    expect(result.current.error).toBeNull();
  });
});

describe('ADR 0517 fix D — a lapsed session is not a missing key', () => {
  it('reports `session-expired` when anonymous and this browser had a binding', async () => {
    // The exact reported scenario: the 24h cookie lapses, the request lands on a
    // fresh `anon:` tenant that cannot see workspace secrets, and the old hook
    // showed "Add your API key".
    localStorage.setItem(LS_KEY, JSON.stringify(GOOGLE));
    getActiveConfig.mockResolvedValue(empty(true));
    listStoredRefs.mockResolvedValue([]);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('session-expired'));
    expect(putActiveConfig).not.toHaveBeenCalled();
  });

  it('keeps the cached pointer through the lapse so signing back in heals it', async () => {
    localStorage.setItem(LS_KEY, JSON.stringify(GOOGLE));
    getActiveConfig.mockResolvedValue(empty(true));
    listStoredRefs.mockResolvedValue([]);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('session-expired'));
    expect(localStorage.getItem(LS_KEY)).not.toBeNull();
  });

  it('a genuinely NEW anonymous visitor still gets the honest first-run wizard', async () => {
    // The distinction must not swing the other way: someone who has never stored
    // a key needs the wizard, not a sign-in wall.
    getActiveConfig.mockResolvedValue(empty(true));
    listStoredRefs.mockResolvedValue([]);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('needs-key'));
  });
});

describe('ADR 0517 fix C — the browser-local pointer migrates to the server', () => {
  it('promotes a localStorage-only binding on first load, once', async () => {
    // Every existing user is in this state on the day this ships. Their pointer
    // is local; their key is on the server. One PUT and the browser stops
    // mattering.
    localStorage.setItem(LS_KEY, JSON.stringify(GOOGLE));
    getActiveConfig.mockResolvedValue(empty(false));
    listStoredRefs.mockResolvedValue(['byok:google']);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(putActiveConfig).toHaveBeenCalledWith(expect.objectContaining({ credentialRef: 'byok:google' }));
  });

  it('migrates a HISTORICAL timestamped ref onto the binding', async () => {
    // The seven-row workspace: its cached pointer names a timestamped ref, which
    // is still a perfectly good key. Adoption must recognise it.
    const legacy = { ...GOOGLE, credentialRef: 'byok:google:1785358774187' };
    localStorage.setItem(LS_KEY, JSON.stringify(legacy));
    getActiveConfig.mockResolvedValue(empty(false));
    listStoredRefs.mockResolvedValue(['byok:google:1782080112882', 'byok:google:1785358774187']);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.config?.credentialRef).toBe('byok:google:1785358774187');
  });

  it('re-points a cached ref whose key is gone at another key for the same provider', async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...GOOGLE, credentialRef: 'byok:google:deleted' }));
    getActiveConfig.mockResolvedValue(empty(false));
    listStoredRefs.mockResolvedValue(['byok:google:1785358774187']);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.config?.credentialRef).toBe('byok:google:1785358774187');
  });

  it('falls back to needs-key — not a broken chat — when the server refuses the heal', async () => {
    localStorage.setItem(LS_KEY, JSON.stringify(GOOGLE));
    getActiveConfig.mockResolvedValue(empty(false));
    listStoredRefs.mockResolvedValue(['byok:google']);
    putActiveConfig.mockRejectedValue(new Error('validation_error'));

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('needs-key'));
  });

  it('heals a STALE SERVER binding whose key was deleted, using another stored key', async () => {
    getActiveConfig.mockResolvedValue({ config: { ...GOOGLE, credentialRef: 'byok:google:gone' }, valid: false, anonymous: false });
    listStoredRefs.mockResolvedValue(['byok:google']);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.config?.credentialRef).toBe('byok:google');
  });
});

describe('ADR 0517 — needs-key is reserved for a genuinely empty workspace', () => {
  it('asks for a key only when there is no binding and nothing to adopt', async () => {
    getActiveConfig.mockResolvedValue(empty(false));
    listStoredRefs.mockResolvedValue([]);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('needs-key'));
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });

  it('exposes storedRefs so the wizard can OFFER an existing key', async () => {
    getActiveConfig.mockResolvedValue(empty(false));
    listStoredRefs.mockResolvedValue(['byok:openai']);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('needs-key'));
    expect(result.current.storedRefs).toEqual(['byok:openai']);
  });
});

describe('ADR 0517 — setConfig is server-first', () => {
  it('does not paint a chat the server would not stand behind', async () => {
    getActiveConfig.mockResolvedValue(empty(false));
    listStoredRefs.mockResolvedValue([]);
    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('needs-key'));

    putActiveConfig.mockRejectedValue(new Error('credentialRef is not a stored BYOK secret'));
    await expect(act(async () => { await result.current.setConfig(GOOGLE); }))
      .rejects.toThrow(/not a stored BYOK secret/);
    expect(result.current.status).not.toBe('ready');
  });

  it('clears server-side too, so the pointer cannot resurrect from another device', async () => {
    getActiveConfig.mockResolvedValue({ config: GOOGLE, valid: true, anonymous: false });
    listStoredRefs.mockResolvedValue(['byok:google']);
    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => { await result.current.setConfig(null); });
    expect(clearActiveConfig).toHaveBeenCalled();
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });
});

describe('ADR 0517 fix A/B — ref selection', () => {
  it('prefers the deterministic ref over historical timestamped ones', () => {
    expect(preferredRefForProvider(['byok:google:1782080112882', 'byok:google'], 'google')).toBe('byok:google');
  });

  it('otherwise takes the newest timestamped ref', () => {
    expect(preferredRefForProvider(
      ['byok:google:1782080112882', 'byok:google:1785358774187'], 'google',
    )).toBe('byok:google:1785358774187');
  });

  it('never crosses a provider boundary', () => {
    // `startsWith('byok:google')` alone would bind the chat to a DIFFERENT
    // provider's key and dispatch with it — a silent wrong-key failure.
    expect(preferredRefForProvider(['byok:google-vertex'], 'google')).toBeNull();
    expect(refsForProvider(['managed:minimax', 'byok:openai'], 'google')).toEqual([]);
  });

  it('returns null when the provider has nothing stored', () => {
    expect(preferredRefForProvider(['byok:openai'], 'google')).toBeNull();
  });
});


describe('ADR 0517 Phase E — the surface waits for auth, and heals when it lands', () => {
  it('concludes NOTHING while auth is still resolving', async () => {
    // The boot-window race. Answering here means answering for whichever session
    // happened to exist at that instant — which is how a restored user got told
    // their session had ended.
    subject = { status: 'pending' };
    getActiveConfig.mockResolvedValue(empty(true));
    listStoredRefs.mockResolvedValue([]);

    const { result } = renderHook(() => useBYOKConfig());
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.status).toBe('loading');
    expect(getActiveConfig).not.toHaveBeenCalled();
  });

  it('re-reads when the identity settles, so a silent re-auth heals the surface', async () => {
    subject = { status: 'pending' };
    getActiveConfig.mockResolvedValue({ config: GOOGLE, valid: true, anonymous: false });
    listStoredRefs.mockResolvedValue(['byok:google']);

    const { result, rerender } = renderHook(() => useBYOKConfig());
    expect(result.current.status).toBe('loading');

    subject = { status: 'user', subject: 'user:abc' };
    rerender();
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('does not cry "session expired" while the auth layer says we ARE signed in', async () => {
    // `reconcileRestoredSession` re-promotes the backend session from Firebase's
    // restored token. Until it lands the backend legitimately answers
    // anonymous:true for a user who is about to be signed in — believing that
    // would be the same false alarm as the key wizard, one layer up.
    localStorage.setItem(LS_KEY, JSON.stringify(GOOGLE));
    subject = { status: 'user', subject: 'user:abc' };
    getActiveConfig
      .mockResolvedValueOnce(empty(true))                                   // handshake still in flight
      .mockResolvedValue({ config: GOOGLE, valid: true, anonymous: false }); // it landed
    listStoredRefs.mockResolvedValue(['byok:google']);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'), { timeout: 4000 });
    expect(result.current.status).not.toBe('session-expired');
  });

  it('the grace retry still FIRES after StrictMode — a cleanup-only guard kills it', async () => {
    // MEASURED: under StrictMode the effect sequence is effect,cleanup,effect, so a
    // cleanup-only `mounted` guard ends at FALSE and every later grace retry bails
    // — silently disabling the whole Phase E heal. The observable is the RETRY
    // ITSELF, so count the calls rather than the end state: the end state can be
    // reached by other paths, which is why an earlier version of this test passed
    // against the bug.
    localStorage.setItem(LS_KEY, JSON.stringify(GOOGLE));
    subject = { status: 'user', subject: 'user:abc' };
    getActiveConfig.mockResolvedValue(empty(true)); // never settles ⇒ retry is the only extra call
    listStoredRefs.mockResolvedValue([]);

    renderHook(() => useBYOKConfig(), {
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    });
    // Wait past the 1.2s grace, then assert a retry happened at all.
    await waitFor(
      () => expect(getActiveConfig.mock.calls.length).toBeGreaterThan(reAuthBaselineCalls),
      { timeout: 4000 },
    );
  });

  it('still reports session-expired when the re-auth genuinely does not land', async () => {
    // The grace is ONE bounded retry, not an indefinite spinner. If the handshake
    // really failed, the honest answer is the sign-in card.
    localStorage.setItem(LS_KEY, JSON.stringify(GOOGLE));
    subject = { status: 'user', subject: 'user:abc' };
    getActiveConfig.mockResolvedValue(empty(true));
    listStoredRefs.mockResolvedValue([]);

    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('session-expired'), { timeout: 4000 });
  });
});
